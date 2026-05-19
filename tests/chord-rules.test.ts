import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChord, fingerStates } from '../src/chord-rules';
import { makeHand, ALL_STATES } from './fixtures';

// For each idealized gesture fixture, verify that:
//   1. The finger-state detector returns the exact intended boolean pattern.
//   2. The classifier maps it to the expected chord.

const EXPECTED_CHORD: Record<string, string> = {
  fist: 'E',
  'index-only': 'D',
  'thumb-only': 'C',
  peace: 'Em',
  rock: 'A',
  three: 'Am',
  gun: 'Dm',
  'four-tucked': 'G',
  'open-palm': 'F',
};

for (const { name, state } of ALL_STATES) {
  test(`finger-state detector: ${name}`, () => {
    const lm = makeHand(state);
    const detected = fingerStates(lm);
    assert.deepEqual(detected, state, `expected ${JSON.stringify(state)}, got ${JSON.stringify(detected)}`);
  });
}

for (const { name, state } of ALL_STATES) {
  test(`chord classifier: ${name} → ${EXPECTED_CHORD[name]}`, () => {
    const lm = makeHand(state);
    const { chord } = classifyChord(lm);
    assert.equal(chord, EXPECTED_CHORD[name]);
  });
}
