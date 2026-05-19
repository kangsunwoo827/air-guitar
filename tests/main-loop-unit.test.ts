// Equivalent integration test for the main render-loop pipeline:
//   detect (mocked) → classifyChord+ChordStabilizer → StrumDetector → drawHands
//
// We don't import src/main.ts (it's a DOM entry point and would try to query
// elements that don't exist in Node). Instead we exercise the same composition
// of public modules with a mock CanvasRenderingContext2D so the canvas-drawing
// arm of the pipeline is actually invoked — confirming the chain is wired
// together end-to-end without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChord, ChordStabilizer } from '../src/chord-rules';
import { StrumDetector, type StrumEvent } from '../src/strum';
import { drawHands } from '../src/draw';
import { makeChordHand } from './fixtures';
import type { Hand, Landmark } from '../src/mediapipe';

type CtxCall = { op: string; args?: unknown[] };

function makeMockCtx(width: number, height: number): { ctx: CanvasRenderingContext2D; calls: CtxCall[] } {
  const calls: CtxCall[] = [];
  const record = (op: string, ...args: unknown[]) => calls.push({ op, args });
  const ctx = {
    canvas: { width, height },
    clearRect: (...a: unknown[]) => record('clearRect', ...a),
    beginPath: () => record('beginPath'),
    moveTo: (...a: unknown[]) => record('moveTo', ...a),
    lineTo: (...a: unknown[]) => record('lineTo', ...a),
    stroke: () => record('stroke'),
    arc: (...a: unknown[]) => record('arc', ...a),
    fill: () => record('fill'),
    fillText: (...a: unknown[]) => record('fillText', ...a),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    font: '',
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function wristAt(y: number, x = 0.85): Landmark[] {
  const lm: Landmark[] = new Array(21).fill(0).map(() => ({ x, y, z: 0 }));
  lm[0] = { x, y, z: 0 };
  return lm;
}

function buildHands(chordLandmarks: Landmark[], strumWristY: number): Hand[] {
  return [
    { landmarks: chordLandmarks, worldLandmarks: [], handedness: 'Left', score: 0.95 },
    { landmarks: wristAt(strumWristY), worldLandmarks: [], handedness: 'Right', score: 0.95 },
  ];
}

function ramp(start: number, end: number, frames: number): number[] {
  const arr: number[] = [];
  for (let i = 0; i < frames; i++) arr.push(start + (end - start) * (i / Math.max(1, frames - 1)));
  return arr;
}

test('main_loop_unit: detect → classify+stabilize → strum → draw runs as a single pipeline', () => {
  const stab = new ChordStabilizer(3);
  const det = new StrumDetector();
  const { ctx, calls } = makeMockCtx(1280, 720);

  const chordLm = makeChordHand('G');
  let currentChord: string | null = null;
  const strumEvents: StrumEvent[] = [];

  // 20 frames of holding G with a steady right wrist — no strum yet.
  // The stabilizer's minHold=3 should converge to 'G' within the first few frames,
  // and drawHands should fire on every frame because we always supply two hands.
  let t = 1000;
  const baselineY = 0.30;
  for (let f = 0; f < 20; f++) {
    const hands = buildHands(chordLm, baselineY);
    // detect step is mocked — we substitute `hands` directly, the way main.ts
    // does when window.__airDiag.forceHands is set.
    const chordHand = hands.find((h) => h.handedness === 'Left') ?? null;
    const strumHand = hands.find((h) => h.handedness === 'Right') ?? null;
    const raw = chordHand ? classifyChord(chordHand.landmarks).chord : null;
    const stable = stab.update(raw);
    currentChord = stable;
    const ev = det.update(strumHand ? strumHand.landmarks : null, t);
    if (ev) strumEvents.push(ev);
    drawHands(ctx, hands);
    t += 16;
  }

  // After the hold, a downward strum.
  for (const y of ramp(baselineY, 0.70, 12)) {
    const hands = buildHands(chordLm, y);
    const strumHand = hands.find((h) => h.handedness === 'Right') ?? null;
    const chordHand = hands.find((h) => h.handedness === 'Left') ?? null;
    const raw = chordHand ? classifyChord(chordHand.landmarks).chord : null;
    const stable = stab.update(raw);
    currentChord = stable;
    const ev = det.update(strumHand ? strumHand.landmarks : null, t);
    if (ev) strumEvents.push(ev);
    drawHands(ctx, hands);
    t += 16;
  }

  // Assertions: every pipeline stage produced its expected effect.

  // 1. Chord classifier + stabilizer settled on 'G'.
  assert.equal(currentChord, 'G', `expected currentChord='G', got ${currentChord}`);

  // 2. Strum detector fired exactly one down event during the down-ramp.
  assert.equal(strumEvents.length, 1, `expected 1 strum event, got ${strumEvents.length}`);
  assert.equal(strumEvents[0].dir, 'down');

  // 3. drawHands was actually invoked — clearRect once per frame (32 frames),
  //    plus per-hand begin/stroke/arc/fill calls. We check both directly.
  const clearCalls = calls.filter((c) => c.op === 'clearRect').length;
  const strokeCalls = calls.filter((c) => c.op === 'stroke').length;
  const fillCalls = calls.filter((c) => c.op === 'fill').length;
  const fillTextCalls = calls.filter((c) => c.op === 'fillText').length;
  assert.equal(clearCalls, 32, `expected 32 clearRect calls (one per frame), got ${clearCalls}`);
  // 2 hands × 32 frames = 64 strokes (one per hand per frame)
  assert.equal(strokeCalls, 64, `expected 64 stroke calls, got ${strokeCalls}`);
  // 21 landmarks × 2 hands × 32 frames = 1344 joint fills
  assert.equal(fillCalls, 21 * 2 * 32, `expected ${21 * 2 * 32} fill calls, got ${fillCalls}`);
  // Hand label drawn for each hand each frame.
  assert.equal(fillTextCalls, 2 * 32, `expected ${2 * 32} fillText calls, got ${fillTextCalls}`);

  console.log(`  frames processed: 32`);
  console.log(`  ctx ops: clearRect=${clearCalls}, stroke=${strokeCalls}, fill=${fillCalls}, fillText=${fillTextCalls}`);
  console.log(`  chord stabilized: ${currentChord}`);
  console.log(`  strum events: ${strumEvents.length} (dir=${strumEvents[0].dir})`);
  console.log(`PASS — main_loop_unit (detect→classify→stabilize→strum→draw, 32 frames, drawHands invoked ${clearCalls}x, chord=G, 1 down strum)`);
});
