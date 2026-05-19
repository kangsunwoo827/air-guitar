import type { Landmark } from './mediapipe';
import type { ChordName } from './audio';

// 21-landmark indices
const WRIST = 0;
const THUMB_MCP = 2;
const THUMB_IP = 3;
const THUMB_TIP = 4;
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

/** Cosine of angle between vectors a and b (range -1..1). */
function cosAngle(a: Vec, b: Vec): number {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-6 || lb < 1e-6) return 0;
  return dot(a, b) / (la * lb);
}

/** Is a non-thumb finger extended? Checks straightness at PIP and length beyond it. */
function fingerExtended(lm: Landmark[], mcp: number, pip: number, tip: number): boolean {
  const vA = sub(lm[pip], lm[mcp]);
  const vB = sub(lm[tip], lm[pip]);
  const straight = cosAngle(vA, vB); // ~1 if straight, ~-1 if curled back
  const reachBeyondPip = dist(lm[tip], lm[mcp]) > dist(lm[pip], lm[mcp]) * 1.2;
  return straight > 0.5 && reachBeyondPip;
}

/** Thumb extension: angle at IP joint plus spread away from palm. */
function thumbExtended(lm: Landmark[]): boolean {
  const v1 = sub(lm[THUMB_IP], lm[THUMB_MCP]);
  const v2 = sub(lm[THUMB_TIP], lm[THUMB_IP]);
  const straight = cosAngle(v1, v2);
  if (straight < 0.3) return false; // bent thumb

  // Palm width as scale reference (index MCP ↔ pinky MCP).
  const palmWidth = dist(lm[INDEX_MCP], lm[PINKY_MCP]);
  if (palmWidth < 1e-6) return false;
  // Distance from thumb tip to the index MCP, normalized by palm width.
  const tipToIndexMcp = dist(lm[THUMB_TIP], lm[INDEX_MCP]) / palmWidth;
  // Also distance from thumb tip to wrist line. Extended thumbs reach far.
  const tipToWrist = dist(lm[THUMB_TIP], lm[WRIST]) / palmWidth;
  return tipToIndexMcp > 0.55 && tipToWrist > 0.95;
}

export type FingerState = {
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
};

export function fingerStates(lm: Landmark[]): FingerState {
  return {
    thumb: thumbExtended(lm),
    index: fingerExtended(lm, INDEX_MCP, INDEX_PIP, INDEX_TIP),
    middle: fingerExtended(lm, MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP),
    ring: fingerExtended(lm, RING_MCP, RING_PIP, RING_TIP),
    pinky: fingerExtended(lm, PINKY_MCP, PINKY_PIP, PINKY_TIP),
  };
}

/** Chord gesture map. Each pattern is a 5-tuple (thumb, index, middle, ring, pinky). */
export const CHORD_GESTURES: Array<{
  chord: ChordName;
  pattern: [boolean, boolean, boolean, boolean, boolean];
  hint: string;
}> = [
  { chord: 'E',  pattern: [false, false, false, false, false], hint: 'fist' },
  { chord: 'D',  pattern: [false, true,  false, false, false], hint: 'index ☝️' },
  { chord: 'C',  pattern: [true,  false, false, false, false], hint: 'thumb 👍' },
  { chord: 'Em', pattern: [false, true,  true,  false, false], hint: 'peace ✌️' },
  { chord: 'A',  pattern: [false, true,  false, false, true ], hint: 'rock 🤘' },
  { chord: 'Am', pattern: [false, true,  true,  true,  false], hint: 'three ☝️✌️🤟' },
  { chord: 'Dm', pattern: [true,  true,  true,  false, false], hint: 'gun 👍✌️' },
  { chord: 'G',  pattern: [false, true,  true,  true,  true ], hint: 'four (thumb tucked)' },
  { chord: 'F',  pattern: [true,  true,  true,  true,  true ], hint: 'open palm 🖐' },
];

function patternMatch(s: FingerState, p: readonly [boolean, boolean, boolean, boolean, boolean]): boolean {
  return s.thumb === p[0] && s.index === p[1] && s.middle === p[2] && s.ring === p[3] && s.pinky === p[4];
}

export function classifyChord(lm: Landmark[]): { chord: ChordName | null; state: FingerState } {
  const state = fingerStates(lm);
  for (const g of CHORD_GESTURES) {
    if (patternMatch(state, g.pattern)) {
      return { chord: g.chord, state };
    }
  }
  return { chord: null, state };
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
