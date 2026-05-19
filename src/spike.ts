import type { Hand } from './mediapipe';
import { audio } from './audio';

/**
 * T1 latency spike: detect a clap (two hands rapidly closing distance) and play a ping.
 * Measures end-to-end visual latency = (estimated audible time) - (frame capture time).
 */
export class ClapLatencyTracker {
  private prevDist: number | null = null;
  private prevT: number | null = null;
  private clapLockUntil = 0;
  readonly samples: number[] = [];
  private readonly maxSamples = 10;

  reset(): void {
    this.prevDist = null;
    this.prevT = null;
    this.clapLockUntil = 0;
    this.samples.length = 0;
  }

  /** Returns latency in ms if a clap fired this frame, else null. */
  tick(hands: Hand[], frameCaptureMs: number, tMs: number): number | null {
    if (hands.length < 2) {
      this.prevDist = null;
      this.prevT = null;
      return null;
    }
    if (tMs < this.clapLockUntil) return null;

    const a = hands[0].landmarks[0];
    const b = hands[1].landmarks[0];
    const d = Math.hypot(a.x - b.x, a.y - b.y);

    let fired = false;
    if (this.prevDist != null && this.prevT != null) {
      const dt = Math.max(1, tMs - this.prevT);
      const closingVel = (this.prevDist - d) / dt; // positive when hands closing
      const closeEnough = d < 0.13;
      const wasFar = this.prevDist > 0.18;
      const fastEnough = closingVel > 0.001;
      if (closeEnough && wasFar && fastEnough) {
        fired = true;
        this.clapLockUntil = tMs + 350;
      }
    }
    this.prevDist = d;
    this.prevT = tMs;

    if (!fired) return null;

    // Play ping immediately.
    const audibleTimeMs = this.scheduleAndComputeAudibleMs();
    const latency = audibleTimeMs - frameCaptureMs;
    this.samples.push(latency);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    return latency;
  }

  private scheduleAndComputeAudibleMs(): number {
    audio.playPing();
    // Convert ctx.currentTime to performance.now() clock using getOutputTimestamp
    // when available; otherwise fall back to perf.now + outputLatency.
    const ctx = audio.ctx;
    const outLatSec = audio.outputLatencySec();
    if (typeof ctx.getOutputTimestamp === 'function') {
      const ts = ctx.getOutputTimestamp();
      const contextTime = ts.contextTime ?? ctx.currentTime;
      const performanceTime = ts.performanceTime ?? performance.now();
      // Sound just scheduled at ctx.currentTime; audible after outputLatency.
      const audibleCtxTime = ctx.currentTime + outLatSec;
      return performanceTime + (audibleCtxTime - contextTime) * 1000;
    }
    return performance.now() + outLatSec * 1000;
  }

  stats(): { avg: number; max: number; count: number } {
    const n = this.samples.length;
    if (n === 0) return { avg: 0, max: 0, count: 0 };
    let sum = 0;
    let max = 0;
    for (const v of this.samples) {
      sum += v;
      if (v > max) max = v;
    }
    return { avg: sum / n, max, count: n };
  }
}
