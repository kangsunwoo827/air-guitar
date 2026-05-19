// Synthetic 21-landmark hand poses for unit testing the chord classifier.
// Coordinates use MediaPipe's normalized image space: x right, y down, both 0..1.

import type { Landmark } from '../src/mediapipe';
import type { FingerState } from '../src/chord-rules';

type Pose = Landmark[];

const z = 0;

/**
 * Construct a hand fixture for a given finger state.
 * The hand is upright (fingers pointing up) and roughly centered.
 * Each finger is laid out as a straight line up (extended) or curled back toward the palm (bent).
 * The thumb is rendered either spread to the side (extended) or tucked across the palm (curled).
 */
export function makeHand(state: FingerState): Pose {
  // Base anchors (image-space normalized).
  const WRIST = { x: 0.50, y: 0.95, z };
  const INDEX_MCP = { x: 0.435, y: 0.68, z };
  const MIDDLE_MCP = { x: 0.490, y: 0.66, z };
  const RING_MCP = { x: 0.545, y: 0.67, z };
  const PINKY_MCP = { x: 0.595, y: 0.71, z };

  // Thumb anchors depend on extended vs tucked.
  const THUMB_CMC = { x: 0.470, y: 0.86, z };

  let THUMB_MCP, THUMB_IP, THUMB_TIP;
  if (state.thumb) {
    // Thumb spread out to the left (upper-left from wrist).
    THUMB_MCP = { x: 0.405, y: 0.80, z };
    THUMB_IP =  { x: 0.345, y: 0.73, z };
    THUMB_TIP = { x: 0.290, y: 0.66, z };
  } else {
    // Thumb tucked across palm — tip ends up between INDEX_MCP and MIDDLE_MCP,
    // close enough that thumbExtended()'s tipToIndexMcp/palmWidth check fails.
    THUMB_MCP = { x: 0.475, y: 0.81, z };
    THUMB_IP =  { x: 0.480, y: 0.77, z };
    THUMB_TIP = { x: 0.470, y: 0.735, z };
  }

  const lm: Pose = new Array(21).fill(0).map(() => ({ x: 0, y: 0, z }));
  lm[0] = WRIST;
  lm[1] = THUMB_CMC;
  lm[2] = THUMB_MCP;
  lm[3] = THUMB_IP;
  lm[4] = THUMB_TIP;

  layoutFinger(lm, INDEX_MCP,  5,  6,  7,  8, state.index);
  layoutFinger(lm, MIDDLE_MCP, 9, 10, 11, 12, state.middle);
  layoutFinger(lm, RING_MCP,   13, 14, 15, 16, state.ring);
  layoutFinger(lm, PINKY_MCP,  17, 18, 19, 20, state.pinky);

  return lm;
}

/**
 * Place MCP, PIP, DIP, TIP for a single non-thumb finger.
 * Extended → straight line upward.
 * Bent → PIP a little above MCP, then DIP and TIP curl back down toward the palm.
 */
function layoutFinger(
  lm: Landmark[],
  mcp: Landmark,
  iMcp: number,
  iPip: number,
  iDip: number,
  iTip: number,
  extended: boolean,
): void {
  lm[iMcp] = mcp;
  if (extended) {
    // Straight finger pointing up (y decreases).
    lm[iPip] = { x: mcp.x, y: mcp.y - 0.07, z };
    lm[iDip] = { x: mcp.x, y: mcp.y - 0.12, z };
    lm[iTip] = { x: mcp.x, y: mcp.y - 0.17, z };
  } else {
    // Curled finger: small step up, then back down toward palm.
    lm[iPip] = { x: mcp.x,         y: mcp.y - 0.04, z };
    lm[iDip] = { x: mcp.x - 0.005, y: mcp.y - 0.015, z };
    lm[iTip] = { x: mcp.x - 0.01,  y: mcp.y + 0.005, z };
  }
}

export const ALL_STATES: Array<{ name: string; state: FingerState }> = [
  { name: 'fist',        state: { thumb: false, index: false, middle: false, ring: false, pinky: false } },
  { name: 'index-only',  state: { thumb: false, index: true,  middle: false, ring: false, pinky: false } },
  { name: 'thumb-only',  state: { thumb: true,  index: false, middle: false, ring: false, pinky: false } },
  { name: 'peace',       state: { thumb: false, index: true,  middle: true,  ring: false, pinky: false } },
  { name: 'rock',        state: { thumb: false, index: true,  middle: false, ring: false, pinky: true  } },
  { name: 'three',       state: { thumb: false, index: true,  middle: true,  ring: true,  pinky: false } },
  { name: 'gun',         state: { thumb: true,  index: true,  middle: true,  ring: false, pinky: false } },
  { name: 'four-tucked', state: { thumb: false, index: true,  middle: true,  ring: true,  pinky: true  } },
  { name: 'open-palm',   state: { thumb: true,  index: true,  middle: true,  ring: true,  pinky: true  } },
];
