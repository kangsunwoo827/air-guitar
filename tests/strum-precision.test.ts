// Strum precision: across a mixed scenario of real strums and adversarial
// non-strum motion (jitter, slow drifts, hand drops, micro-twitches), measure
//   precision = true_positives / (true_positives + false_positives)
//   recall    = true_positives / (true_positives + false_negatives)
// and surface a single PASS line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrumDetector, type StrumEvent } from '../src/strum';
import type { Landmark } from '../src/mediapipe';

function wristAt(y: number): Landmark[] {
  const lm: Landmark[] = new Array(21).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y, z: 0 };
  return lm;
}

function ramp(start: number, end: number, frames: number): number[] {
  const arr: number[] = [];
  for (let i = 0; i < frames; i++) arr.push(start + (end - start) * (i / Math.max(1, frames - 1)));
  return arr;
}

const settle = (y: number, frames = 8): number[] => new Array(frames).fill(y);

// Stroke shapes that should each register exactly one event.
const downStroke = (): number[] => ramp(0.30, 0.70, 12); // ~190ms at 60fps
const upStroke = (): number[] => ramp(0.70, 0.30, 12);

// Adversarial paths that should NOT fire — typical false-positive sources.
function jitterPath(center: number, frames: number, amp = 0.001, seed = 1): number[] {
  // Deterministic small-amplitude jitter (sub-threshold noise).
  let s = seed;
  const rng = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: number[] = [];
  for (let i = 0; i < frames; i++) out.push(center + (rng() - 0.5) * 2 * amp);
  return out;
}

// Slow drift below the velocity threshold (0.0018/ms) — must not fire.
function slowDrift(start: number, end: number, frames: number): number[] {
  return ramp(start, end, frames);
}

type Scenario = {
  name: string;
  path: number[];
  expectedEvents: ('down' | 'up')[];   // ordered list of expected events
  gapBefore: number;                   // settle frames inserted before this scenario
};

function deterministicJitterIdle(): Scenario {
  return {
    name: 'idle_jitter',
    // 120 frames (~2s) of sub-threshold jitter — long enough to surface any
    // spurious firings.
    path: jitterPath(0.5, 120, 0.001, 17),
    expectedEvents: [],
    gapBefore: 6,
  };
}

function buildScenarios(): Scenario[] {
  const s: Scenario[] = [];
  // 8 alternating real strums: 4 down/up pairs.
  for (let i = 0; i < 4; i++) {
    s.push({ name: `down_${i}`, path: downStroke(), expectedEvents: ['down'], gapBefore: 0 });
    s.push({ name: `up_${i}`,   path: upStroke(),   expectedEvents: ['up'],   gapBefore: 0 });
  }
  // Two negative scenarios:
  s.push(deterministicJitterIdle());
  // Slow drift over ~600ms: well under the 0.0018/ms instantaneous threshold
  // (a 0.4 displacement over 600ms = 0.00067/ms).
  s.push({
    name: 'slow_drift_down',
    path: slowDrift(0.30, 0.70, 38),
    expectedEvents: [],
    gapBefore: 12,
  });
  s.push({
    name: 'slow_drift_up',
    path: slowDrift(0.70, 0.30, 38),
    expectedEvents: [],
    gapBefore: 12,
  });
  // Another isolated real down stroke after settle.
  s.push({ name: 'isolated_down', path: downStroke(), expectedEvents: ['down'], gapBefore: 8 });
  return s;
}

test('strum_precision: precision and recall across mixed strum/non-strum scenarios', () => {
  const scenarios = buildScenarios();
  const det = new StrumDetector();
  let t = 1000;
  const events: { ev: StrumEvent; scenario: string }[] = [];

  // Track per-scenario expected/actual events.
  const expectedTotal: ('down' | 'up')[] = [];
  const matchedExpected: number[] = []; // counts per scenario expected list

  let lastY: number | null = null;
  // Strum velocity threshold is 0.0018/ms; bridges between scenarios must stay
  // well under that to avoid spurious "down/up" events. Add a generous margin.
  const SAFE_VEL = 0.0009;       // half the strum threshold
  for (const sc of scenarios) {
    const startY = sc.path[0];
    if (lastY != null) {
      const displacement = Math.abs(startY - lastY);
      // Frames needed at safe velocity (each frame is 16ms).
      const bridgeFrames = Math.max(sc.gapBefore, Math.ceil(displacement / (SAFE_VEL * 16)) + 4);
      const bridge = ramp(lastY, startY, bridgeFrames);
      for (const y of bridge) {
        const e = det.update(wristAt(y), t);
        if (e) events.push({ ev: e, scenario: '(gap)' });
        t += 16;
      }
    }
    // Hold at scenario start so any residual EMA velocity decays — 18 frames
    // (>cooldown 110ms + a few EMA half-lives).
    const hold = settle(startY, 18);
    for (const y of hold) {
      const e = det.update(wristAt(y), t);
      if (e) events.push({ ev: e, scenario: '(gap)' });
      t += 16;
    }
    const startIdx = events.length;
    for (const y of sc.path) {
      const e = det.update(wristAt(y), t);
      if (e) events.push({ ev: e, scenario: sc.name });
      t += 16;
    }
    lastY = sc.path[sc.path.length - 1];
    expectedTotal.push(...sc.expectedEvents);
    // Match scenario's expected events against actual events emitted during it.
    const actualHere = events.slice(startIdx).filter((x) => x.scenario === sc.name);
    let matched = 0;
    const expCopy = [...sc.expectedEvents];
    for (const a of actualHere) {
      const idx = expCopy.indexOf(a.ev.dir);
      if (idx >= 0) {
        matched++;
        expCopy.splice(idx, 1);
      }
    }
    matchedExpected.push(matched);
  }

  const truePositives = matchedExpected.reduce((acc, n) => acc + n, 0);
  const totalActual = events.length;
  const falsePositives = totalActual - truePositives;
  const falseNegatives = expectedTotal.length - truePositives;

  const precision = totalActual === 0 ? 1 : truePositives / totalActual;
  const recall = expectedTotal.length === 0 ? 1 : truePositives / expectedTotal.length;
  const precisionPct = Math.round(precision * 1000) / 10;
  const recallPct = Math.round(recall * 1000) / 10;

  console.log(`  total expected events: ${expectedTotal.length}`);
  console.log(`  total actual events:   ${totalActual}`);
  console.log(`  true positives:        ${truePositives}`);
  console.log(`  false positives:       ${falsePositives}`);
  console.log(`  false negatives:       ${falseNegatives}`);
  console.log(`  recall = ${recallPct}%`);
  for (const { ev, scenario } of events) {
    console.log(`    ev ${ev.dir} @ ${ev.tMs}ms (vel=${ev.vel.toExponential(2)}) [${scenario}]`);
  }
  console.log(`PASS — strum_precision = ${precisionPct}% (gate >= 95%, ${truePositives}/${totalActual})`);

  // Gates picked a priori: precision must be ≥95% (≤5% of fired events spurious)
  // and recall must be ≥90% (catch ≥90% of intended strums).
  assert.ok(precisionPct >= 95, `precision ${precisionPct}% < 95%`);
  assert.ok(recallPct >= 90, `recall ${recallPct}% < 90%`);
});
