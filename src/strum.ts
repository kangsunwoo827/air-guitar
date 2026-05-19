import type { Landmark } from './mediapipe';

export type StrumEvent = { dir: 'down' | 'up'; tMs: number; vel: number };

/**
 * Strum detector: tracks vertical velocity of the right-hand wrist landmark.
 * Triggers `down` when velocity goes from <0 to >+threshold (hand moving toward bottom of frame),
 * and `up` when velocity flips back the other way. Cooldown prevents double-fires.
 *
 * Image-space y increases downward (MediaPipe normalized coordinates).
 */
export class StrumDetector {
  private prevY: number | null = null;
  private prevT: number | null = null;
  private velY = 0;                 // smoothed velocity (units: normalized y per ms)
  private lastDir: 'down' | 'up' | null = null;
  private lastFireMs = 0;
  private readonly velThreshold = 0.0018;  // normalized-y / ms; tuned for ~60fps gestures
  private readonly cooldownMs = 110;

  reset(): void {
    this.prevY = null;
    this.prevT = null;
    this.velY = 0;
    this.lastDir = null;
    this.lastFireMs = 0;
  }

  /** Use wrist (lm[0]) as the strum anchor. Returns an event if fired this frame. */
  update(lm: Landmark[] | null, tMs: number): StrumEvent | null {
    if (!lm) {
      this.prevY = null;
      this.prevT = null;
      return null;
    }
    const y = lm[0].y;
    if (this.prevY == null || this.prevT == null) {
      this.prevY = y;
      this.prevT = tMs;
      return null;
    }
    const dt = tMs - this.prevT;
    if (dt <= 0) return null;
    const instV = (y - this.prevY) / dt;
    // EMA smoothing — keep fast response.
    this.velY = this.velY * 0.4 + instV * 0.6;
    this.prevY = y;
    this.prevT = tMs;

    if (tMs - this.lastFireMs < this.cooldownMs) return null;

    if (this.velY > this.velThreshold && this.lastDir !== 'down') {
      this.lastDir = 'down';
      this.lastFireMs = tMs;
      return { dir: 'down', tMs, vel: this.velY };
    }
    if (this.velY < -this.velThreshold && this.lastDir !== 'up') {
      this.lastDir = 'up';
      this.lastFireMs = tMs;
      return { dir: 'up', tMs, vel: this.velY };
    }
    return null;
  }
}
