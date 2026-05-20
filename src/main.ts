import './style.css';
import { HandTracker, type FrameDetection, type Hand, type InitProgress } from './mediapipe';
import { audio, type ChordName } from './audio';
import { classifyChord, ChordStabilizer, CHORD_LIST, CHORD_HINTS } from './chord-rules';
import { StrumDetector, type StrumEvent } from './strum';
import { drawHands, sizeCanvasTo, renderExpectedChart, renderDetectedChart } from './draw';
import { ClapLatencyTracker } from './spike';

// Diagnostic hook — e2e drivers attach `__airDiag.forceHands` to short-circuit
// MediaPipe detection with a synthesized Hand[] (used by `npm run live-e2e` so
// the pipeline can be exercised end-to-end inside headless Chrome with the
// fake video device, where no actual hand is in frame).
type DiagState = {
  frameCount: number;
  drawCalls: number;
  lastChord: ChordName | null;
  lastError: string | null;
  forceHands?: (tMs: number) => Hand[];
};
declare global {
  interface Window {
    __airDiag?: DiagState;
  }
}
const diag: DiagState = { frameCount: 0, drawCalls: 0, lastChord: null, lastError: null };
window.__airDiag = diag;

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
const chartExpectedEl = document.getElementById('chart-expected') as unknown as SVGSVGElement;
const chartDetectedEl = document.getElementById('chart-detected') as unknown as SVGSVGElement;
// Offscreen canvas that we drawImage(video) into each frame, then hand to
// tracker.detect. Some Chrome configurations crash inside MediaPipe's
// video→texture path with `Cannot read properties of undefined (reading
// 'activeTexture')` when an HTMLVideoElement is passed directly to
// detectForVideo; copying the frame through a 2D canvas first uses a
// different internal upload path that's been more reliable.
const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d');
const loadingEl = $<HTMLDivElement>('loading');
const loadingPhaseEl = loadingEl.querySelector('.phase') as HTMLDivElement;
const loadingBarEl = loadingEl.querySelector('.bar') as HTMLDivElement;
const loadingBarFillEl = loadingEl.querySelector('.bar-fill') as HTMLDivElement;
const loadingHintEl = loadingEl.querySelector('.hint') as HTMLDivElement;

function showLoading(phase: string, pct?: number, hint?: string): void {
  loadingEl.hidden = false;
  loadingPhaseEl.textContent = phase;
  if (pct == null) {
    loadingBarEl.setAttribute('data-indeterminate', '1');
    loadingBarFillEl.style.width = '';
  } else {
    loadingBarEl.removeAttribute('data-indeterminate');
    loadingBarFillEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }
  loadingHintEl.textContent = hint ?? '';
}

function hideLoading(): void {
  loadingEl.hidden = true;
}

function progressToLoading(p: InitProgress): void {
  const hint =
    p.phase === 'model'
      ? '첫 로드 시에만 다운로드 (이후 캐시)'
      : p.phase === 'probe'
      ? 'GPU graph 가능 여부 확인 중...'
      : p.phase === 'fallback'
      ? 'GPU 사용 불가 → CPU로 전환 (3x 느림, 동작은 동일)'
      : p.phase === 'graph'
      ? `${p.delegate ?? ''} 그래프 시작 중...`
      : '';
  showLoading(p.message, p.pct, hint);
}

renderLegend();
// Initial empty render so the panel isn't blank before the user presses START.
renderExpectedChart(chartExpectedEl, null);
renderDetectedChart(chartDetectedEl, null, null);

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
// Stickiness window: keep the last good chord usable for strum a short time
// after detection drops it. A brief MediaPipe wobble right at the strum frame
// shouldn't silence the chord — the user already saw it on screen.
let lastStableChord: ChordName | null = null;
let lastStableChordAt = 0;
const CHORD_STICK_MS = 300;
// If detect() throws repeatedly the loop would spin forever spamming the
// console, masking the real failure. After a few consecutive frame failures
// we stop the loop and surface a clear retry path to the user.
let consecutiveFrameErrors = 0;
const MAX_FRAME_ERRORS = 5;

if (new URLSearchParams(location.search).has('perf-test')) {
  startBtn.textContent = 'Run perf self-test';
  startBtn.addEventListener('click', runPerfSelfTest, { once: true });
} else {
  startBtn.addEventListener('click', start, { once: true });
}

async function runPerfSelfTest(): Promise<void> {
  startBtn.disabled = true;
  setStatus('initializing audio + mediapipe...');
  showLoading('audio + mediapipe 초기화...');
  await audio.init();
  await audio.resume();
  await tracker.init(progressToLoading);
  hideLoading();

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

/** Release any state from a previous run so a retry doesn't leak the prior
 *  HandLandmarker's GL context or stack up orphaned camera tracks. */
function teardown(): void {
  running = false;
  if (video.srcObject) {
    const s = video.srcObject as MediaStream;
    for (const t of s.getTracks()) t.stop();
    video.srcObject = null;
  }
  tracker.close();
  consecutiveFrameErrors = 0;
}

/** Probe whether we can create a WebGL2 context the same way MediaPipe will.
 *  If this fails before MediaPipe even loads, the activeTexture crash is an
 *  environment problem (extension patching getContext, GPU process down,
 *  context pool exhausted) rather than anything in MediaPipe. */
function probeWebGL2(): { ok: boolean; reason: string } {
  try {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    // MediaPipe asks with these attributes; mirror them so a refusal here
    // would also be a refusal for MediaPipe.
    const attrs: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: true,
      stencil: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: true,
      powerPreference: 'default',
    };
    const gl = c.getContext('webgl2', attrs) as WebGL2RenderingContext | null;
    if (!gl) {
      return { ok: false, reason: "canvas.getContext('webgl2') returned null" };
    }
    // Touch a method MediaPipe uses early — if a wallet extension has
    // monkey-patched the prototype to throw or return undefined we'll see it.
    if (typeof gl.activeTexture !== 'function') {
      return { ok: false, reason: 'gl.activeTexture is not a function (patched away?)' };
    }
    gl.activeTexture(gl.TEXTURE0);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      return { ok: false, reason: `gl.getError() = 0x${err.toString(16)} after activeTexture probe` };
    }
    // Best-effort context loss to free it.
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    return { ok: true, reason: 'WebGL2 OK' };
  } catch (e) {
    return { ok: false, reason: `threw: ${(e as Error).message}` };
  }
}

async function start(): Promise<void> {
  startBtn.disabled = true;
  teardown();

  // Diagnostic: tell the user up front if WebGL2 is broken in this tab.
  // The CPU-delegate activeTexture crashes we've been chasing happen
  // *inside* MediaPipe but the root cause is canvas.getContext('webgl2')
  // returning null — running our own probe surfaces that immediately
  // instead of waiting for a confusing detect() error.
  const probe = probeWebGL2();
  if (!probe.ok) {
    showLoading('WebGL2 사용 불가', undefined, `진단: ${probe.reason}\n확장프로그램(MetaMask, SES 등) 비활성화 / 시크릿 모드 시도 권장`);
    setStatus(`WebGL2 unavailable: ${probe.reason}`);
    statsEl.textContent = `WebGL2 PROBE FAIL: ${probe.reason}\n→ 다른 Chrome 탭 모두 닫기, 또는 시크릿(extensions OFF)에서 재시도`;
    startBtn.disabled = false;
    startBtn.textContent = 'RETRY';
    startBtn.addEventListener('click', start, { once: true });
    return;
  }

  showLoading('카메라 권한 요청 중...');
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
    await tracker.init(progressToLoading);
    showLoading('오디오 준비 중...');
    setStatus('loading audio...');
    await audio.init();
    await audio.resume();

    hideLoading();
    setStatus(`running (${tracker.delegate()})`);
    // Populate the HUD immediately so the user sees the stats / chord panel
    // before requestVideoFrameCallback fires its first frame (which can lag a
    // few hundred ms on cold cache, especially under the CPU delegate).
    statsEl.textContent =
      `mode: PLAY   delegate: ${tracker.delegate()}   chord-hand: ${chordHandSide}   waiting for first frame...`;
    chordLabelEl.textContent = '—';
    running = true;
    loop();
  } catch (err) {
    hideLoading();
    setStatus(`ERROR: ${(err as Error).message}`);
    teardown();
    startBtn.disabled = false;
    startBtn.textContent = 'RETRY';
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

  // (A synchronous warm-up processFrame was removed: if MediaPipe's first
  // detect happens to hang — e.g. broken GPU graph that auto-probe missed —
  // doing it on the main thread freezes the tab. rVFC fires within ~33ms in
  // the common case, which is fast enough for the HUD placeholder.)

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

  try {
    sizeCanvasTo(video, overlay);
    // Copy the current video frame onto detectCanvas and feed THAT to
    // MediaPipe instead of the live video element (see canvas declaration
    // above for the activeTexture-crash reasoning). Skip the detect entirely
    // if the video hasn't produced a real frame yet.
    if (!video.videoWidth || !video.videoHeight || !detectCtx) return;
    if (detectCanvas.width !== video.videoWidth || detectCanvas.height !== video.videoHeight) {
      detectCanvas.width = video.videoWidth;
      detectCanvas.height = video.videoHeight;
    }
    detectCtx.drawImage(video, 0, 0);
    let det: FrameDetection = tracker.detect(detectCanvas, tMs);
    // Diagnostic short-circuit: e2e tests can inject synthetic hands so the
    // rest of the pipeline (draw + classify + strum) runs without a real hand
    // being visible to the camera.
    if (diag.forceHands) {
      det = { ...det, hands: diag.forceHands(tMs) };
    }
    const ctx = overlay.getContext('2d');
    if (ctx) {
      drawHands(ctx, det.hands);
      if (det.hands.length > 0) diag.drawCalls++;
    }
    if (modeSpikeEl.checked) {
      runSpikeMode(det, frameCaptureMs, tMs);
    } else {
      runPlayMode(det, tMs);
    }
    diag.frameCount++;
    consecutiveFrameErrors = 0;
  } catch (err) {
    diag.lastError = (err as Error).message;
    console.error('processFrame error:', err);
    consecutiveFrameErrors++;
    statsEl.textContent = `processFrame ERROR (${tracker.delegate()}): ${(err as Error).message}\n실패 ${consecutiveFrameErrors}회 연속${consecutiveFrameErrors >= MAX_FRAME_ERRORS ? ' — 루프 정지, RETRY 누르세요' : ''}`;
    if (consecutiveFrameErrors >= MAX_FRAME_ERRORS) {
      // Loop is wedged. Stop it cleanly and prepare a retry path so the user
      // isn't stuck staring at a broken-but-still-spinning screen.
      running = false;
      teardown();
      // Re-run the WebGL2 probe now that we know MediaPipe is unhappy — if
      // it fails post-init, something inside the page (or an extension)
      // tore the GL context down mid-flight.
      const postProbe = probeWebGL2();
      const msg = (err as Error).message ?? '';
      const diagnosis = /activeTexture|GLctx|WebGL/.test(msg)
        ? `\n\n진단: MediaPipe가 WebGL2 컨텍스트를 잃었거나 못 얻음. WebGL2 재검사 결과: ${postProbe.ok ? 'OK (브라우저는 컨텍스트 줄 수 있음 → MediaPipe 자체 버그 의심)' : `FAIL — ${postProbe.reason}`}\n→ 다른 Chrome 탭 모두 닫기 / 시크릿 모드 시도 / 확장프로그램 비활성화`
        : '';
      setStatus(`stopped after ${consecutiveFrameErrors} detect errors`);
      statsEl.textContent =
        `processFrame ERROR (${tracker.delegate()}): ${msg}\n실패 ${consecutiveFrameErrors}회 연속 — 루프 정지${diagnosis}`;
      startBtn.disabled = false;
      startBtn.textContent = 'RETRY';
      startBtn.addEventListener('click', start, { once: true });
    }
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
  const cls = chordHand ? classifyChord(chordHand.landmarks) : null;
  const raw: ChordName | null = cls?.chord ?? null;
  const stable = chordStab.update(raw);
  currentChord = stable;
  if (stable) {
    lastStableChord = stable;
    lastStableChordAt = tMs;
  }
  chordLabelEl.textContent = stable ?? '—';
  diag.lastChord = stable;

  // Render the chord-diagram panel: ideal fingering on the left, what the
  // hand currently looks like on the right. Updates every frame so the user
  // can see why a chord isn't classifying.
  renderExpectedChart(chartExpectedEl, stable);
  renderDetectedChart(chartDetectedEl, cls?.state ?? null, cls?.tips ?? null);

  // Strum detection. If chord just blinked out for a frame at the strum
  // moment, fall back to the most recent stable chord within CHORD_STICK_MS.
  const event = strum.update(strumHand ? strumHand.landmarks : null, tMs);
  const chordForStrum =
    currentChord ??
    (lastStableChord && tMs - lastStableChordAt < CHORD_STICK_MS ? lastStableChord : null);
  if (event && chordForStrum) {
    audio.playChord(chordForStrum, event.dir);
    lastStrum = event;
    flashStrum();
  } else if (event) {
    // strum without recognized chord — give visual feedback only
    lastStrum = event;
    flashStrum();
  }

  const lastStrumAge = lastStrum ? `${(tMs - lastStrum.tMs).toFixed(0)}ms ago (${lastStrum.dir})` : 'none';
  const fingers = cls ? formatFingers(cls.state) : '(no chord hand)';
  const strumPos = strumHand
    ? `wrist y=${strumHand.landmarks[0].y.toFixed(2)}`
    : '(no strum hand)';

  const outLatMs = audio.outputLatencySec() * 1000;
  const latWarn = outLatMs > 60 ? '⚠ Bluetooth/HDMI?' : '';
  statsEl.textContent =
    `mode: PLAY   fps: ${fps.toFixed(1)}   chord-hand: ${chordHandSide}   audio_out: ${outLatMs.toFixed(0)}ms ${latWarn}\n` +
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

// Click stats or status to copy contents to clipboard — makes it easy to share
// the running state when debugging ("here's what my screen says").
async function copyOnClick(el: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(el.textContent ?? '');
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 400);
  } catch {
    // Fallback for older browsers / non-secure contexts.
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}
statsEl.addEventListener('click', () => copyOnClick(statsEl));
statusEl.addEventListener('click', () => copyOnClick(statusEl));

// Toggle chord/strum hand mapping by pressing "S".
window.addEventListener('keydown', (e) => {
  if (e.key === 's' || e.key === 'S') {
    chordHandSide = chordHandSide === 'Left' ? 'Right' : 'Left';
  }
});
