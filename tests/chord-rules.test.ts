import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChord, fingerStates } from '../src/chord-rules';
import { makeChordHand, ALL_CHORDS, CHORD_FIXTURES } from './fixtures';

// For each chord's idealized fingering fixture:
//   1. The finger-state detector reports the intended press/ext/curl pattern.
//   2. The classifier returns the expected chord.

for (const chord of ALL_CHORDS) {
  test(`finger states match plan: ${chord}`, () => {
    const lm = makeChordHand(chord);
    const states = fingerStates(lm);
    const plan = CHORD_FIXTURES[chord];
    assert.equal(states.index, plan.index.state, `${chord} index: expected ${plan.index.state}, got ${states.index}`);
    assert.equal(states.middle, plan.middle.state, `${chord} middle: expected ${plan.middle.state}, got ${states.middle}`);
    assert.equal(states.ring, plan.ring.state, `${chord} ring: expected ${plan.ring.state}, got ${states.ring}`);
    assert.equal(states.pinky, plan.pinky.state, `${chord} pinky: expected ${plan.pinky.state}, got ${states.pinky}`);
  });
}

for (const chord of ALL_CHORDS) {
  test(`classifyChord: ${chord}`, () => {
    const lm = makeChordHand(chord);
    const { chord: detected, bestDist } = classifyChord(lm);
    assert.equal(detected, chord, `expected ${chord}, got ${detected} (distance ${bestDist.toFixed(3)})`);
  });
}
