// Integration test simulating a full G→D→Em→C progression with 4 strums,
// exercising the entire detect-pipeline (excluding browser-only audio output):
//   1. chord-hand landmarks feed `classifyChord` + `ChordStabilizer`
//   2. strum-hand wrist motion feeds `StrumDetector`
//   3. on each strum event the "currently stable" chord is the one that would
//      be sent to `audio.playChord(chord, dir)`
//
// Asserts that the 4 strums map cleanly to the chord progression in order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChord, ChordStabilizer } from '../src/chord-rules';
import { StrumDetector, type StrumEvent } from '../src/strum';
import { makeChordHand } from './fixtures';
import type { Landmark } from '../src/mediapipe';
import type { ChordName } from '../src/audio';

function wristAt(y: number): Landmark[] {
  const lm: Landmark[] = new Array(21).fill(0).map(() => ({ x: 0.5, y, z: 0 }));
  lm[0] = { x: 0.5, y, z: 0 };
  return lm;
}

function ramp(start: number, end: number, frames: number): number[] {
  const arr: number[] = [];
  for (let i = 0; i < frames; i++) arr.push(start + (end - start) * (i / Math.max(1, frames - 1)));
  return arr;
}

// One frame of synthesized input: chord hand + strum-hand wrist y.
type Frame = { chord: ChordName; wristY: number };

function buildFrames(): { frames: Frame[]; dirs: ('down' | 'up')[] } {
  const frames: Frame[] = [];
  const progression: ChordName[] = ['G', 'D', 'Em', 'C'];
  // Real-world strum pattern is alternating down/up — the detector itself only
  // re-arms after the direction flips. So 4 strums = down-up-down-up.
  const dirs: ('down' | 'up')[] = ['down', 'up', 'down', 'up'];

  let currentY = 0.30;
  for (let i = 0; i < progression.length; i++) {
    const chord = progression[i];
    // Hold steady at currentY with current chord. 16 frames @ 60fps ≈ 270ms,
    // enough for the ChordStabilizer's minHold(3) to lock in.
    for (let f = 0; f < 16; f++) frames.push({ chord, wristY: currentY });
    // Strum stroke.
    const dir = dirs[i];
    const endY = dir === 'down' ? 0.70 : 0.30;
    const stroke = ramp(currentY, endY, 12);
    for (const y of stroke) frames.push({ chord, wristY: y });
    currentY = endY;
  }
  return { frames, dirs };
}

test('chord_progression_integration: G→D→Em→C + 4 strums = 4 (chord, down) events', () => {
  const stab = new ChordStabilizer(3);
  const det = new StrumDetector();

  // Pre-build chord-hand landmarks per chord — they don't move within this test
  // (we're not simulating realistic hand drift, we're checking pipeline integration).
  const chordHands: Record<ChordName, Landmark[]> = {
    G:  makeChordHand('G'),
    D:  makeChordHand('D'),
    Em: makeChordHand('Em'),
    C:  makeChordHand('C'),
    A:  makeChordHand('A'),
    Am: makeChordHand('Am'),
    E:  makeChordHand('E'),
    Dm: makeChordHand('Dm'),
    F:  makeChordHand('F'),
  };

  const events: { chord: ChordName | null; dir: 'down' | 'up'; tMs: number }[] = [];
  let t = 1000;
  const built = buildFrames();
  for (const frame of built.frames) {
    const raw = classifyChord(chordHands[frame.chord]).chord;
    const stable = stab.update(raw);
    const strumEv: StrumEvent | null = det.update(wristAt(frame.wristY), t);
    if (strumEv) {
      events.push({ chord: stable, dir: strumEv.dir, tMs: strumEv.tMs });
    }
    t += 16;
  }

  console.log('  events fired:');
  for (const ev of events) console.log(`    ${ev.dir} ${ev.chord ?? '—'} @ ${ev.tMs}ms`);

  assert.equal(events.length, 4, `expected 4 strum events, got ${events.length}`);
  const expectedChords: ChordName[] = ['G', 'D', 'Em', 'C'];
  for (let i = 0; i < expectedChords.length; i++) {
    assert.equal(events[i].chord, expectedChords[i], `event ${i}: expected chord ${expectedChords[i]}, got ${events[i].chord}`);
    assert.equal(events[i].dir, built.dirs[i], `event ${i}: expected ${built.dirs[i]}, got ${events[i].dir}`);
  }

  console.log(`PASS — chord_progression_integration (G→D→Em→C, 4 strums [${built.dirs.join('-')}], all chords correctly bound to strum events)`);
});
