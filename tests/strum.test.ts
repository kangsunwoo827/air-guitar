import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrumDetector, type StrumEvent } from '../src/strum';
import type { Landmark } from '../src/mediapipe';

function wristAt(y: number): Landmark[] {
  const lm: Landmark[] = new Array(21).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y, z: 0 };
  return lm;
}

// Replays a single contiguous y-path through the detector; returns all emitted events.
function runPath(yPath: number[], dtMs = 16, startT = 1000): { events: StrumEvent[]; det: StrumDetector } {
  const det = new StrumDetector();
  const events: StrumEvent[] = [];
  let t = startT;
  for (const y of yPath) {
    const ev = det.update(wristAt(y), t);
    if (ev) events.push(ev);
    t += dtMs;
  }
  return { events, det };
}

function ramp(start: number, end: number, frames: number): number[] {
  const arr: number[] = [];
  for (let i = 0; i < frames; i++) arr.push(start + (end - start) * (i / (frames - 1)));
  return arr;
}
// ~190ms per stroke at 60fps — a comfortable real-strum pace that gives
// the 110ms cooldown enough headroom for both DOWN and UP to fire per cycle.
const downStroke = (): number[] => ramp(0.30, 0.70, 12);
const upStroke = (): number[] => ramp(0.70, 0.30, 12);
const settle = (y: number, frames = 8): number[] => new Array(frames).fill(y);

test('10 alternating down/up cycles fire 10 down + 10 up events', () => {
  const cycles: number[][] = [];
  for (let i = 0; i < 10; i++) cycles.push(...[downStroke(), upStroke()]);
  const path = [...settle(0.30, 6), ...cycles.flat()];
  const { events } = runPath(path);
  const downs = events.filter((e) => e.dir === 'down').length;
  const ups = events.filter((e) => e.dir === 'up').length;
  assert.equal(downs, 10, `expected 10 downs, got ${downs}; events: ${JSON.stringify(events.map((e) => e.dir))}`);
  assert.equal(ups, 10, `expected 10 ups, got ${ups}`);
});

test('10 alternating up/down cycles fire 10 up + 10 down events', () => {
  const cycles: number[][] = [];
  for (let i = 0; i < 10; i++) cycles.push(...[upStroke(), downStroke()]);
  const path = [...settle(0.70, 6), ...cycles.flat()];
  const { events } = runPath(path);
  const downs = events.filter((e) => e.dir === 'down').length;
  const ups = events.filter((e) => e.dir === 'up').length;
  assert.equal(ups, 10, `expected 10 ups, got ${ups}`);
  assert.equal(downs, 10, `expected 10 downs, got ${downs}`);
});

test('idle hand fires no events', () => {
  const jitter: number[] = [];
  for (let i = 0; i < 60; i++) jitter.push(0.5 + Math.sin(i * 0.7) * 0.0005);
  const path = [...settle(0.5, 6), ...jitter];
  const { events } = runPath(path);
  assert.equal(events.length, 0, `expected 0 events, got ${events.length}`);
});

test('hand disappears then re-appears: no spurious event', () => {
  const det = new StrumDetector();
  let t = 1000;
  for (const y of settle(0.5, 6)) {
    det.update(wristAt(y), t);
    t += 16;
  }
  det.update(null, t);
  t += 16;
  const ev = det.update(wristAt(0.7), t);
  assert.equal(ev, null);
});

test('single down stroke fires exactly one down', () => {
  const path = [...settle(0.30, 6), ...downStroke()];
  const { events } = runPath(path);
  assert.equal(events.length, 1, `expected 1 event, got ${events.length}; events=${JSON.stringify(events)}`);
  assert.equal(events[0].dir, 'down');
});
