// Robustness test: each chord fixture is perturbed with small Gaussian noise on
// every landmark to simulate noisy MediaPipe output, and we measure how often
// the classifier still returns the correct chord. The percentage across all
// 9 chords × N trials is surfaced as a single PASS line.
//
// Threshold (ACCURACY_GATE below): 90% across 50 perturbed trials per chord.
// What this measures: noise-margin around canonical fingerings — i.e. how far
// each fixture sits from the nearest classifier decision boundary under iid
// Gaussian landmark jitter. It does NOT measure real-world accuracy on human
// hands (no negative class, no left-handed users, no non-frontal poses, no
// occlusion). It's a regression guard on the classifier's stability, not a
// claim about end-to-end recognition quality.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChord } from '../src/chord-rules';
import { makeChordHand, ALL_CHORDS } from './fixtures';
import type { Landmark } from '../src/mediapipe';

// Deterministic PRNG (mulberry32) — so the reported accuracy is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller transform → standard normal.
function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function perturb(lm: Landmark[], sigma: number, rng: () => number): Landmark[] {
  return lm.map((p) => ({
    x: p.x + gauss(rng) * sigma,
    y: p.y + gauss(rng) * sigma,
    z: p.z + gauss(rng) * sigma,
  }));
}

const TRIALS_PER_CHORD = 50;
// MediaPipe HandLandmarker frame-to-frame jitter on a static hand is typically
// 0.001–0.003 in normalized image coordinates. We use sigma=0.002 (≈1% of the
// fixture's palm-width scale) — representative of a steady real-world hand.
const NOISE_SIGMA = 0.002;
// Threshold picked a priori based on the classifier's per-finger angle margins
// (cos windows of ~0.7 / -0.4) and x/y epsilons (0.12, 0.08) being many sigma
// from the realistic noise level: we expect ≥90% across 450 trials.
const ACCURACY_GATE = 90;

test('chord_accuracy: noise-robust classification across all 9 chords', () => {
  const rng = mulberry32(0xa17_91a7);
  const perChord: Record<string, { hits: number; trials: number }> = {};
  let totalHits = 0;
  let totalTrials = 0;

  for (const chord of ALL_CHORDS) {
    const base = makeChordHand(chord);
    let hits = 0;
    for (let i = 0; i < TRIALS_PER_CHORD; i++) {
      const lm = perturb(base, NOISE_SIGMA, rng);
      const { chord: detected } = classifyChord(lm);
      if (detected === chord) hits++;
    }
    perChord[chord] = { hits, trials: TRIALS_PER_CHORD };
    totalHits += hits;
    totalTrials += TRIALS_PER_CHORD;
  }

  const overallPct = Math.round((totalHits / totalTrials) * 1000) / 10;

  // Per-chord report (logged for diagnostics).
  for (const chord of ALL_CHORDS) {
    const { hits, trials } = perChord[chord];
    const pct = Math.round((hits / trials) * 1000) / 10;
    console.log(`  ${chord.padEnd(3)} ${hits}/${trials}  ${pct}%`);
  }
  console.log(`PASS — chord_accuracy = ${overallPct}% (gate >= ${ACCURACY_GATE}%, ${totalHits}/${totalTrials} across ${ALL_CHORDS.length} chords, sigma=${NOISE_SIGMA})`);

  // Hard assertion — fails CI if accuracy drops below the gate.
  assert.ok(
    overallPct >= ACCURACY_GATE,
    `chord_accuracy ${overallPct}% < ${ACCURACY_GATE}% gate`,
  );
});
