// Synthetic 21-landmark hand poses representing each real open-chord fingering,
// constructed in image-normalized space (x right, y down).
//
// Hand is upright with MCPs above the wrist. Each "pressing" finger is laid out
// so that PIP cos(angle) falls inside the moderate-bend window the classifier
// treats as a fret-press. Each "extended" finger points straight up. Each
// "curled" finger collapses back toward the palm.
//
// Bent-finger tip positions are derived from the standard open-chord fingerings
// translated into the hand-local frame the classifier reconstructs.

import type { Landmark } from '../src/mediapipe';
import type { ChordName } from '../src/audio';

type Vec = { x: number; y: number; z: number };

// Image-space anchors of the base hand (used by every fixture).
const WRIST: Vec = { x: 0.50, y: 0.95, z: 0 };
const INDEX_MCP: Vec = { x: 0.435, y: 0.68, z: 0 };
const MIDDLE_MCP: Vec = { x: 0.490, y: 0.66, z: 0 };
const RING_MCP: Vec = { x: 0.545, y: 0.67, z: 0 };
const PINKY_MCP: Vec = { x: 0.595, y: 0.71, z: 0 };

// Thumb is held flat behind the neck — its landmarks don't influence the
// classifier (it ignores thumb state) but the array must have 21 entries.
const THUMB_CMC: Vec = { x: 0.470, y: 0.86, z: 0 };
const THUMB_MCP: Vec = { x: 0.460, y: 0.81, z: 0 };
const THUMB_IP: Vec  = { x: 0.475, y: 0.77, z: 0 };
const THUMB_TIP: Vec = { x: 0.480, y: 0.735, z: 0 };

// Frame-aligned palm geometry — x ≈ image x, y ≈ -image y (palm up).
const SCALE = Math.hypot(INDEX_MCP.x - PINKY_MCP.x, INDEX_MCP.y - PINKY_MCP.y);

function localToWorld(xL: number, yL: number): Vec {
  return { x: WRIST.x + xL * SCALE, y: WRIST.y - yL * SCALE, z: 0 };
}

type FState = 'press' | 'ext' | 'curl';

type FingerPlan = {
  index: { state: FState; tipLocal?: { x: number; y: number } };
  middle: { state: FState; tipLocal?: { x: number; y: number } };
  ring: { state: FState; tipLocal?: { x: number; y: number } };
  pinky: { state: FState; tipLocal?: { x: number; y: number } };
};

// Tip targets per chord, in hand-local coordinates (palm-widths).
// y > 0 = above the wrist (toward fingertips). x ≈ string position
// (lower x = thumb-side / low-pitch strings; higher x = pinky-side / high-pitch strings).
export const CHORD_FIXTURES: Record<ChordName, FingerPlan> = {
  // Em — middle + ring at fret 2; index, pinky unused.
  Em: {
    index:  { state: 'ext' },
    middle: { state: 'press', tipLocal: { x: 0.10, y: 2.20 } },
    ring:   { state: 'press', tipLocal: { x: 0.30, y: 2.20 } },
    pinky:  { state: 'ext' },
  },
  // F — index barre (1st fret, across) + middle 2/G + ring 3/A + pinky 3/D.
  F: {
    index:  { state: 'press', tipLocal: { x: 0.05, y: 2.00 } },
    middle: { state: 'press', tipLocal: { x: 0.15, y: 2.20 } },
    ring:   { state: 'press', tipLocal: { x: 0.40, y: 2.35 } },
    pinky:  { state: 'press', tipLocal: { x: 0.55, y: 2.25 } },
  },
  // A — all 3 fingers on fret 2, adjacent strings (4/3/2). All same y.
  A: {
    index:  { state: 'press', tipLocal: { x: -0.20, y: 2.20 } },
    middle: { state: 'press', tipLocal: { x:  0.10, y: 2.20 } },
    ring:   { state: 'press', tipLocal: { x:  0.40, y: 2.20 } },
    pinky:  { state: 'ext' },
  },
  // D — index 2/G + middle 2/e + ring 3/B. I and M same y, R higher.
  D: {
    index:  { state: 'press', tipLocal: { x: -0.10, y: 2.20 } },
    middle: { state: 'press', tipLocal: { x:  0.50, y: 2.20 } },
    ring:   { state: 'press', tipLocal: { x:  0.20, y: 2.45 } },
    pinky:  { state: 'ext' },
  },
  // Am — index 1/B + middle 2/D + ring 2/G. I lower, M & R same.
  Am: {
    index:  { state: 'press', tipLocal: { x:  0.35, y: 2.00 } },
    middle: { state: 'press', tipLocal: { x: -0.10, y: 2.20 } },
    ring:   { state: 'press', tipLocal: { x:  0.20, y: 2.20 } },
    pinky:  { state: 'ext' },
  },
  // E — same y-pattern as Am but shifted to lower strings (smaller mean x).
  E: {
    index:  { state: 'press', tipLocal: { x:  0.10, y: 2.00 } },
    middle: { state: 'press', tipLocal: { x: -0.35, y: 2.20 } },
    ring:   { state: 'press', tipLocal: { x: -0.05, y: 2.20 } },
    pinky:  { state: 'ext' },
  },
  // C — staircase I < M < R, with x order R < M < I (ring on low string A).
  C: {
    index:  { state: 'press', tipLocal: { x:  0.25, y: 2.00 } },
    middle: { state: 'press', tipLocal: { x:  0.05, y: 2.20 } },
    ring:   { state: 'press', tipLocal: { x: -0.15, y: 2.45 } },
    pinky:  { state: 'ext' },
  },
  // Dm — staircase I < M < R, with x order M < R < I (middle on G string).
  Dm: {
    index:  { state: 'press', tipLocal: { x: 0.50, y: 2.00 } },
    middle: { state: 'press', tipLocal: { x: 0.20, y: 2.20 } },
    ring:   { state: 'press', tipLocal: { x: 0.40, y: 2.45 } },
    pinky:  { state: 'ext' },
  },
  // G — middle on low E (very low x), ring on high e (very high x). Wide spread.
  G: {
    index:  { state: 'press', tipLocal: { x:  0.10, y: 2.05 } },
    middle: { state: 'press', tipLocal: { x: -0.40, y: 2.30 } },
    ring:   { state: 'press', tipLocal: { x:  0.75, y: 2.30 } },
    pinky:  { state: 'ext' },
  },
};

export const ALL_CHORDS: ChordName[] = Object.keys(CHORD_FIXTURES) as ChordName[];

function layoutFinger(
  state: FState,
  mcp: Vec,
  tipLocal: { x: number; y: number } | undefined,
): { pip: Vec; dip: Vec; tip: Vec } {
  if (state === 'ext') {
    return {
      pip: { x: mcp.x, y: mcp.y - 0.07, z: 0 },
      dip: { x: mcp.x, y: mcp.y - 0.12, z: 0 },
      tip: { x: mcp.x, y: mcp.y - 0.17, z: 0 },
    };
  }
  if (state === 'curl') {
    return {
      pip: { x: mcp.x,         y: mcp.y - 0.04, z: 0 },
      dip: { x: mcp.x - 0.005, y: mcp.y - 0.015, z: 0 },
      tip: { x: mcp.x - 0.01,  y: mcp.y + 0.005, z: 0 },
    };
  }
  // press — bent finger reaching toward the provided tip target with a perpendicular bow.
  if (!tipLocal) throw new Error('pressing finger requires tipLocal');
  const tip = localToWorld(tipLocal.x, tipLocal.y);
  const dx = tip.x - mcp.x;
  const dy = tip.y - mcp.y;
  const lenMT = Math.hypot(dx, dy);
  // Perpendicular direction (rotate 90°).
  const perpX = -dy / lenMT;
  const perpY = dx / lenMT;
  // Bow size ≈ 25% of MCP→TIP, yields PIP cos ≈ 0.58 (squarely in the "press" window).
  const bow = 0.25 * lenMT;
  const pip: Vec = {
    x: mcp.x + 0.4 * dx + perpX * bow,
    y: mcp.y + 0.4 * dy + perpY * bow,
    z: 0,
  };
  const dip: Vec = {
    x: mcp.x + 0.7 * dx + perpX * bow * 0.5,
    y: mcp.y + 0.7 * dy + perpY * bow * 0.5,
    z: 0,
  };
  return { pip, dip, tip };
}

export function makeChordHand(chord: ChordName): Landmark[] {
  const plan = CHORD_FIXTURES[chord];
  const lm: Landmark[] = new Array(21).fill(0).map(() => ({ x: 0, y: 0, z: 0 }));

  lm[0] = WRIST;
  lm[1] = THUMB_CMC;
  lm[2] = THUMB_MCP;
  lm[3] = THUMB_IP;
  lm[4] = THUMB_TIP;

  lm[5] = INDEX_MCP;
  const idx = layoutFinger(plan.index.state, INDEX_MCP, plan.index.tipLocal);
  lm[6] = idx.pip; lm[7] = idx.dip; lm[8] = idx.tip;

  lm[9] = MIDDLE_MCP;
  const mid = layoutFinger(plan.middle.state, MIDDLE_MCP, plan.middle.tipLocal);
  lm[10] = mid.pip; lm[11] = mid.dip; lm[12] = mid.tip;

  lm[13] = RING_MCP;
  const rng = layoutFinger(plan.ring.state, RING_MCP, plan.ring.tipLocal);
  lm[14] = rng.pip; lm[15] = rng.dip; lm[16] = rng.tip;

  lm[17] = PINKY_MCP;
  const pky = layoutFinger(plan.pinky.state, PINKY_MCP, plan.pinky.tipLocal);
  lm[18] = pky.pip; lm[19] = pky.dip; lm[20] = pky.tip;

  return lm;
}
