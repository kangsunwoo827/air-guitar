import './style.css';
import { HandTracker, type FrameDetection } from './mediapipe';
import { audio, type ChordName } from './audio';
import { classifyChord, ChordStabilizer, CHORD_LIST, CHORD_HINTS } from './chord-rules';
import { StrumDetector, type StrumEvent } from './strum';
import { drawHands, sizeCanvasTo } from './draw';
import { ClapLatencyTracker } from './spike';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const video = $<HTMLVideoElement>('cam');
const overlay = $<HTMLCanvasElement>('overlay');
const startBtn = $<HTMLButtonElement>('start');
const statusEl = $<HTMLDivElement>('status');
const statsEl = $<HTMLDivElement>('stats');
const chordLabelEl = $<HTMLDivElement>('chord-label');
const strumFlashEl = $<HTMLDivElement>('strum-flash');
const modeSpikeEl = $<HTMLInputElement>('mode-spike');
const legendEl = $<HTMLDivElement>('legend');

renderLegend();

const tracker = new HandTracker();
const clap = new ClapLatencyTracker();
const chordStab = new ChordStabilizer(3);
const strum = new StrumDetector();

let running = false;
let chordHandSide: 'Left' | 'Right' = 'Left';   // which physical hand holds the chord
let currentChord: ChordName | null = null;
let lastStrum: StrumEvent | null = null;
let frameCount = 0;
let lastFpsAt = performance.now();
let fps = 0;

if (new URLSearchParams(location.search).has('perf-test')) {
  startBtn.textContent = 'Run perf self-test';
  startBtn.addEventListener('click', runPerfSelfTest, { once: true });
} else {
  startBtn.addEventListener('click', start, { once: true });
}

async function runPerfSelfTest(): Promise<void> {
  startBtn.disabled = true;
  setStatus('initializing audio + mediapipe...');
  await audio.init();
  await audio.resume();
  await tracker.init();

  // 1) Audio scheduling latency — time from playPing() call to estimated audible moment.
  // audibleMs = scheduling perf.now() + outputLatency_seconds * 1000.
  // baseLatency + outputLatency on AudioContext gives the device-side delay between when a
  // sample is handed to the audio subsystem and when the listener hears it.
  setStatus('measuring audio latency (10 pings)...');
  const ctx0 = audio.ctx;
  const baseLat = ctx0.baseLatency ?? 0;
  const outLat = (ctx0 as unknown as { outputLatency?: number }).outputLatency ?? 0;
  const audioSamples: number[] = [];
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 80));
    const t0 = performance.now();
    audio.playPing();
    // After start(ctx.currentTime), the sample will be heard outputLatency_seconds in the future,
    // measured against the same performance clock t0 is on.
    const out = (audio.ctx as unknown as { outputLatency?: number }).outputLatency ?? 0;
    const audibleMs = t0 + (audio.ctx.baseLatency + out) * 1000;
    audioSamples.push(audibleMs - t0);
  }

  // 2) MediaPipe inference latency — repeated detect() on a synthetic gray frame.
  setStatus('measuring mediapipe inference (10 frames)...');
  const cnv = document.createElement('canvas');
  cnv.width = 640;
  cnv.height = 480;
  const c2d = cnv.getContext('2d');
  if (c2d) {
    c2d.fillStyle = '#888';
    c2d.fillRect(0, 0, cnv.width, cnv.height);
  }
  // Warm-up: first inference includes JIT/lazy-init cost we don't want to measure.
  for (let i = 0; i < 3; i++) {
    tracker.detect(cnv, performance.now());
    await new Promise((r) => setTimeout(r, 30));
  }
  const mpSamples: number[] = [];
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 16));
    const t0 = performance.now();
    tracker.detect(cnv, performance.now());
    mpSamples.push(performance.now() - t0);
  }

  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const maxOf = (xs: number[]): number => xs.reduce((a, b) => Math.max(a, b), 0);
  const aAvg = avg(audioSamples);
  const aMax = maxOf(audioSamples);
  const mAvg = avg(mpSamples);
  const mMax = maxOf(mpSamples);
  const CAMERA_DELAY_ESTIMATE_MS = 35; // typical M-series webcam capture delay
  const totalAvg = aAvg + mAvg + CAMERA_DELAY_ESTIMATE_MS;
  const totalMax = aMax + mMax + CAMERA_DELAY_ESTIMATE_MS;

  const report =
    `audio_avg=${aAvg.toFixed(1)}ms audio_max=${aMax.toFixed(1)}ms ` +
    `mp_avg=${mAvg.toFixed(1)}ms mp_max=${mMax.toFixed(1)}ms ` +
    `total_avg=${totalAvg.toFixed(0)}ms total_max=${totalMax.toFixed(0)}ms`;
  statsEl.textContent =
    `PERF SELF-TEST\n` +
    `audio baseLatency=${(baseLat * 1000).toFixed(1)}ms  outputLatency=${(outLat * 1000).toFixed(1)}ms\n` +
    `audio scheduling     avg ${aAvg.toFixed(1)}ms   max ${aMax.toFixed(1)}ms\n` +
    `mediapipe inference  avg ${mAvg.toFixed(1)}ms   max ${mMax.toFixed(1)}ms\n` +
    `+ camera capture (assumed) ${CAMERA_DELAY_ESTIMATE_MS}ms\n` +
    `≈ total end-to-end   avg ${totalAvg.toFixed(0)}ms   max ${totalMax.toFixed(0)}ms\n` +
    `gate < 150ms: ${totalAvg < 150 ? 'PASS' : 'FAIL'}`;
  setStatus(`perf-done ${totalAvg < 150 ? 'PASS' : 'FAIL'}`);
  // Expose to the title for headless drivers.
  document.title = `PERF ${totalAvg < 150 ? 'PASS' : 'FAIL'} ${report}`;
}

async function start(): Promise<void> {
  startBtn.disabled = true;
  setStatus('requesting camera...');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    sizeCanvasTo(video, overlay);

    setStatus('loading mediapipe...');
    await tracker.init();
    setStatus('loading audio...');
    await audio.init();
    await audio.resume();

    setStatus('running');
    running = true;
    loop();
  } catch (err) {
    setStatus(`ERROR: ${(err as Error).message}`);
    startBtn.disabled = false;
    startBtn.addEventListener('click', start, { once: true });
  }
}

function loop(): void {
  if (!running) return;

  // Use requestVideoFrameCallback for accurate capture timestamps when available.
  type VideoFrameMeta = { mediaTime: number; expectedDisplayTime: number; captureTime?: number };
  const v = video as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, m: VideoFrameMeta) => void) => number;
  };

  const onFrame = (perfNow: number, meta?: VideoFrameMeta): void => {
    const frameCaptureMs = meta?.captureTime ?? perfNow;
    processFrame(frameCaptureMs);
    if (!running) return;
    if (v.requestVideoFrameCallback) {
      v.requestVideoFrameCallback((p, m) => onFrame(p, m as VideoFrameMeta));
    } else {
      requestAnimationFrame((p) => onFrame(p));
    }
  };

  if (v.requestVideoFrameCallback) {
    v.requestVideoFrameCallback((p, m) => onFrame(p, m as VideoFrameMeta));
  } else {
    requestAnimationFrame((p) => onFrame(p));
  }
}

function processFrame(frameCaptureMs: number): void {
  const tMs = performance.now();

  // FPS counter
  frameCount++;
  if (tMs - lastFpsAt > 500) {
    fps = (frameCount * 1000) / (tMs - lastFpsAt);
    frameCount = 0;
    lastFpsAt = tMs;
  }

  // Run MediaPipe on the current frame.
  sizeCanvasTo(video, overlay);
  const det: FrameDetection = tracker.detect(video, tMs);
  const ctx = overlay.getContext('2d');
  if (ctx) drawHands(ctx, det.hands);

  if (modeSpikeEl.checked) {
    runSpikeMode(det, frameCaptureMs, tMs);
  } else {
    runPlayMode(det, tMs);
  }
}

function runSpikeMode(det: FrameDetection, frameCaptureMs: number, tMs: number): void {
  chordLabelEl.classList.add('dim');
  chordLabelEl.textContent = 'SPIKE';

  const fired = clap.tick(det.hands, frameCaptureMs, tMs);
  if (fired != null) {
    flashStrum();
  }
  const s = clap.stats();
  const gate = s.avg > 0 ? (s.avg < 150 ? 'PASS' : 'FAIL') : '...';
  statsEl.textContent =
    `mode: SPIKE   fps: ${fps.toFixed(1)}\n` +
    `clap samples: ${s.count}/10   gate(<150ms avg): ${gate}\n` +
    `avg: ${s.avg.toFixed(1)}ms   max: ${s.max.toFixed(1)}ms\n` +
    (s.count > 0 ? `last10(ms): ${clap.samples.map((v) => v.toFixed(0)).join(' ')}` : '');
}

function runPlayMode(det: FrameDetection, tMs: number): void {
  chordLabelEl.classList.remove('dim');

  // Pick chord-hand and strum-hand by handedness.
  const chordHand = det.hands.find((h) => h.handedness === chordHandSide) ?? null;
  const strumHand = det.hands.find((h) => h.handedness !== chordHandSide) ?? null;

  // Chord classification with smoothing.
  let raw: ChordName | null = null;
  if (chordHand) {
    raw = classifyChord(chordHand.landmarks).chord;
  }
  const stable = chordStab.update(raw);
  currentChord = stable;
  chordLabelEl.textContent = stable ?? '—';

  // Strum detection
  const event = strum.update(strumHand ? strumHand.landmarks : null, tMs);
  if (event && currentChord) {
    audio.playChord(currentChord, event.dir);
    lastStrum = event;
    flashStrum();
  } else if (event) {
    // strum without recognized chord — give visual feedback only
    lastStrum = event;
    flashStrum();
  }

  const lastStrumAge = lastStrum ? `${(tMs - lastStrum.tMs).toFixed(0)}ms ago (${lastStrum.dir})` : 'none';
  const fingers = chordHand
    ? formatFingers(classifyChord(chordHand.landmarks).state)
    : '(no chord hand)';
  const strumPos = strumHand
    ? `wrist y=${strumHand.landmarks[0].y.toFixed(2)}`
    : '(no strum hand)';

  statsEl.textContent =
    `mode: PLAY   fps: ${fps.toFixed(1)}   chord-hand: ${chordHandSide}\n` +
    `chord: ${currentChord ?? '—'}    fingers: ${fingers}\n` +
    `strum: ${strumPos}    last: ${lastStrumAge}`;
}

function formatFingers(s: ReturnType<typeof classifyChord>['state']): string {
  const code = (v: 'press' | 'ext' | 'curl'): string => (v === 'press' ? 'P' : v === 'ext' ? '|' : '·');
  return `${code(s.index)}${code(s.middle)}${code(s.ring)}${code(s.pinky)}`;
}

function flashStrum(): void {
  strumFlashEl.classList.remove('fire');
  // Force reflow to restart transition.
  void strumFlashEl.offsetWidth;
  strumFlashEl.classList.add('fire');
  setTimeout(() => strumFlashEl.classList.remove('fire'), 90);
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function renderLegend(): void {
  const items = CHORD_LIST.map(
    (chord) => `<span class="item"><b>${chord}</b> ${CHORD_HINTS[chord]}</span>`,
  );
  legendEl.innerHTML = items.join('');
}

// Toggle chord/strum hand mapping by pressing "S".
window.addEventListener('keydown', (e) => {
  if (e.key === 's' || e.key === 'S') {
    chordHandSide = chordHandSide === 'Left' ? 'Right' : 'Left';
  }
});
