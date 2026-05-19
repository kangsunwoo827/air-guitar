import type { Landmark } from './mediapipe';
import type { ChordName } from './audio';

// 21-landmark indices
const WRIST = 0;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_MCP = 13;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

type Vec = { x: number; y: number; z: number };

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (v: Vec): number => Math.hypot(v.x, v.y, v.z);
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y + a.z * b.z;
const dist = (a: Vec, b: Vec): number => len(sub(a, b));

/**
 * Cosine of the angle between the proximal (MCP→PIP) and distal (PIP→TIP) segments of a finger.
 *   ~1   = finger straight  (extended)
 *    0   = bent 90°         (pressing)
 *   ~-1  = curled tight     (tucked into palm)
 */
function pipCos(lm: Landmark[], mcp: number, pip: number, tip: number): number {
  const v1 = sub(lm[pip], lm[mcp]);
  const v2 = sub(lm[tip], lm[pip]);
  const la = len(v1);
  const lb = len(v2);
  if (la < 1e-6 || lb < 1e-6) return 1;
  return dot(v1, v2) / (la * lb);
}

type Frame = { origin: Vec; xU: Vec; yU: Vec; scale: number };

/**
 * Right-handed hand-local frame:
 *   origin = wrist
 *   y-axis = wrist → middle MCP (palm length)
 *   x-axis = perpendicular to y, in the direction of pinky MCP
 *   scale  = palm width (index MCP ↔ pinky MCP)
 *
 * Tip coordinates expressed in this frame are invariant to overall hand rotation
 * and roughly invariant to user-to-camera distance.
 */
function handFrame(lm: Landmark[]): Frame {
  const wrist = lm[WRIST];
  const midMcp = lm[MIDDLE_MCP];
  const indexMcp = lm[INDEX_MCP];
  const pinkyMcp = lm[PINKY_MCP];

  const ya = sub(midMcp, wrist);
  const yLen = Math.max(len(ya), 1e-6);
  const yU = { x: ya.x / yLen, y: ya.y / yLen, z: ya.z / yLen };

  const w2p = sub(pinkyMcp, wrist);
  const k = dot(w2p, yU);
  const xRaw = { x: w2p.x - k * yU.x, y: w2p.y - k * yU.y, z: w2p.z - k * yU.z };
  const xLen = Math.max(len(xRaw), 1e-6);
  const xU = { x: xRaw.x / xLen, y: xRaw.y / xLen, z: xRaw.z / xLen };

  const scale = Math.max(dist(indexMcp, pinkyMcp), 1e-6);
  return { origin: wrist, xU, yU, scale };
}

function localXY(p: Vec, f: Frame): { x: number; y: number } {
  const d = sub(p, f.origin);
  return { x: dot(d, f.xU) / f.scale, y: dot(d, f.yU) / f.scale };
}

export type FingerState = {
  index: 'press' | 'ext' | 'curl';
  middle: 'press' | 'ext' | 'curl';
  ring: 'press' | 'ext' | 'curl';
  pinky: 'press' | 'ext' | 'curl';
};

function classifyFinger(lm: Landmark[], mcp: number, pip: number, tip: number): 'press' | 'ext' | 'curl' {
  const c = pipCos(lm, mcp, pip, tip);
  if (c >= 0.7) return 'ext';
  if (c > -0.4) return 'press';
  return 'curl';
}

export function fingerStates(lm: Landmark[]): FingerState {
  return {
    index: classifyFinger(lm, INDEX_MCP, INDEX_PIP, INDEX_TIP),
    middle: classifyFinger(lm, MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP),
    ring: classifyFinger(lm, RING_MCP, RING_PIP, RING_TIP),
    pinky: classifyFinger(lm, PINKY_MCP, PINKY_PIP, PINKY_TIP),
  };
}

/**
 * Three-finger chord classifier — branches on the y- and x-ordering of the bent
 * (I, M, R) fingertips in hand-local space, plus total x-spread.
 *
 * Y axis ≈ fret position (larger y = higher fret / further from the nut).
 * X axis ≈ string position (larger x = high-pitch string side; smaller x = low-pitch).
 */
function classifyThreeFingerChord(
  I: { x: number; y: number },
  M: { x: number; y: number },
  R: { x: number; y: number },
): ChordName | null {
  const yEps = 0.12;
  const xEps = 0.08;
  const sameY = (a: number, b: number): boolean => Math.abs(a - b) < yEps;
  const xRange = Math.max(I.x, M.x, R.x) - Math.min(I.x, M.x, R.x);

  // G is the only chord whose three bent tips span the full neck (middle finger
  // on the low-E side, ring on the high-e side). Detect it first.
  if (xRange > 0.7) return 'G';

  // A — all 3 fingertips on the same fret (same y).
  if (sameY(I.y, M.y) && sameY(M.y, R.y)) return 'A';

  // D — index and middle at fret 2, ring at fret 3.
  if (sameY(I.y, M.y) && R.y > M.y + yEps) return 'D';

  // I < M = R → Am or E (compact 3-finger). Distinguish by mean tip x:
  // E sits on lower-pitch strings → smaller mean x; Am sits one string higher.
  if (I.y < M.y - yEps && sameY(M.y, R.y)) {
    const meanX = (I.x + M.x + R.x) / 3;
    return meanX < 0.05 ? 'E' : 'Am';
  }

  // I < M < R staircase → C or Dm (or a fallback G if x just barely missed).
  if (I.y < M.y - yEps && M.y < R.y - yEps) {
    // C: ring on a low-pitch string (smallest x), index on a high-pitch (largest x).
    if (R.x < M.x - xEps && M.x < I.x - xEps) return 'C';
    // Dm: middle on the G string (smallest x), ring on B, index on e.
    if (M.x < R.x - xEps && R.x < I.x - xEps) return 'Dm';
    // Loose fallback: pick by which of R or M is leftmost.
    return R.x < M.x ? 'C' : 'Dm';
  }

  return null;
}

export function classifyChord(lm: Landmark[]): { chord: ChordName | null; state: FingerState; bestDist: number } {
  const state = fingerStates(lm);
  const frame = handFrame(lm);
  const I = localXY(lm[INDEX_TIP], frame);
  const M = localXY(lm[MIDDLE_TIP], frame);
  const R = localXY(lm[RING_TIP], frame);

  const pI = state.index === 'press';
  const pM = state.middle === 'press';
  const pR = state.ring === 'press';
  const pP = state.pinky === 'press';

  // 2 fingers pressing: must be middle + ring (Em). Others wouldn't make a chord.
  if (pM && pR && !pI && !pP) return { chord: 'Em', state, bestDist: 0 };

  // All 4 fingers pressing → F (barre chord shape).
  if (pI && pM && pR && pP) return { chord: 'F', state, bestDist: 0 };

  // 3 fingers (index + middle + ring) pressing → branch on tip arrangement.
  if (pI && pM && pR && !pP) {
    const chord = classifyThreeFingerChord(I, M, R);
    return { chord, state, bestDist: 0 };
  }

  return { chord: null, state, bestDist: 0 };
}

/** Temporal smoothing: chord must persist for >= n frames before becoming "current". */
export class ChordStabilizer {
  private last: ChordName | null = null;
  private candidate: ChordName | null = null;
  private candidateCount = 0;
  private readonly minHold: number;

  constructor(minHold = 3) {
    this.minHold = minHold;
  }

  update(c: ChordName | null): ChordName | null {
    if (c === this.last) {
      this.candidate = null;
      this.candidateCount = 0;
      return this.last;
    }
    if (c === this.candidate) {
      this.candidateCount++;
      if (this.candidateCount >= this.minHold) {
        this.last = c;
        this.candidate = null;
        this.candidateCount = 0;
      }
    } else {
      this.candidate = c;
      this.candidateCount = 1;
    }
    return this.last;
  }
}

/** Re-export for legend rendering — the chord list in canonical order. */
export const CHORD_LIST: ChordName[] = ['E', 'Am', 'Dm', 'G', 'C', 'D', 'A', 'Em', 'F'];

/** Short human description of how to make each chord pose (real open-chord fingering). */
export const CHORD_HINTS: Record<ChordName, string> = {
  E: '검지 1번 / 중지·약지 2번 (낮은 줄)',
  Am: '검지 1번 / 중지·약지 2번 (가운데 줄)',
  Dm: '검지 1번 / 중지 2번 / 약지 3번 (높은 줄, 좁게)',
  G: '검지 2번 / 중지 3번 (가장 굵은 줄) / 약지 3번 (가장 가는 줄) — 와이드',
  C: '검지 1번 / 중지 2번 / 약지 3번 — 계단 모양',
  D: '검지·중지 2번 / 약지 3번 — 삼각형',
  A: '검지·중지·약지 모두 2번 — 한 줄로',
  Em: '중지·약지만 2번, 검지·새끼 안 씀',
  F: '검지 1번 (가로 barre) + 중지 2번 + 약지·새끼 3번',
};
