// Web Audio: low-latency interactive context with pre-built ping & chord buffers.
// All chord audio is synthesized at startup so there are no external sample assets to load.

export type ChordName = 'C' | 'G' | 'D' | 'Em' | 'Am' | 'Dm' | 'F' | 'E' | 'A';

// Standard open-position chord pitches at concert pitch, low → high.
// E uses low E, A, D, G, B, e strings. We approximate the 6-string sound.
const CHORD_FREQS: Record<ChordName, number[]> = {
  // Notes derived from standard fingerings; missing/muted strings omitted.
  E:  [82.41, 123.47, 164.81, 207.65, 246.94, 329.63],   // E B E G# B E
  Am: [110.00, 164.81, 220.00, 261.63, 329.63],          // A E A C E
  Dm: [146.83, 220.00, 293.66, 349.23],                  // D A D F
  G:  [98.00, 123.47, 146.83, 196.00, 246.94, 392.00],   // G B D G B G(high)
  C:  [130.81, 164.81, 196.00, 261.63, 329.63],          // C E G C E
  D:  [146.83, 220.00, 293.66, 369.99],                  // D A D F#
  A:  [110.00, 164.81, 220.00, 277.18, 329.63],          // A E A C# E
  F:  [87.31, 130.81, 174.61, 220.00, 261.63, 349.23],   // F C F A C F
  Em: [82.41, 123.47, 164.81, 196.00, 246.94, 329.63],   // E B E G B E
};

class AudioEngine {
  ctx!: AudioContext;
  master!: GainNode;
  pingBuffer!: AudioBuffer;
  chordDown!: Record<ChordName, AudioBuffer>;
  chordUp!: Record<ChordName, AudioBuffer>;
  ready = false;

  async init(): Promise<void> {
    if (this.ready) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // latencyHint: 0 requests the smallest latency the user agent can deliver.
    // Falls back to 'interactive' on browsers that don't accept a numeric hint.
    try {
      this.ctx = new Ctor({ latencyHint: 0 as unknown as AudioContextLatencyCategory });
    } catch {
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);

    this.pingBuffer = this.buildPing(this.ctx);
    this.chordDown = {} as Record<ChordName, AudioBuffer>;
    this.chordUp = {} as Record<ChordName, AudioBuffer>;
    // Pre-build BOTH directions so playChord() never synthesizes on the audio hot path.
    for (const name of Object.keys(CHORD_FREQS) as ChordName[]) {
      this.chordDown[name] = this.buildChord(this.ctx, CHORD_FREQS[name]);
      this.chordUp[name] = this.buildChord(this.ctx, [...CHORD_FREQS[name]].reverse());
    }
    // resume() must be called on user gesture; caller does this on START.
    this.ready = true;
  }

  resume(): Promise<void> {
    return this.ctx.resume();
  }

  /** Play a quick attack-decay ping for the latency test. Returns the AudioContext time at which playback was scheduled. */
  playPing(): number {
    const src = this.ctx.createBufferSource();
    src.buffer = this.pingBuffer;
    src.connect(this.master);
    const when = this.ctx.currentTime;
    src.start(when);
    return when;
  }

  /** Play a chord. `direction` flips the strum order (down = low→high, up = high→low). */
  playChord(name: ChordName, direction: 'down' | 'up'): number {
    const buf = direction === 'down' ? this.chordDown[name] : this.chordUp[name];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master);
    const when = this.ctx.currentTime;
    src.start(when);
    return when;
  }

  /** Estimated total audio output delay in seconds (base + output). */
  outputLatencySec(): number {
    const base = this.ctx.baseLatency || 0;
    // outputLatency is a Chrome property (experimental). Fall back to 0 elsewhere.
    const out = (this.ctx as unknown as { outputLatency?: number }).outputLatency || 0;
    return base + out;
  }

  private buildPing(ctx: AudioContext): AudioBuffer {
    const sr = ctx.sampleRate;
    const dur = 0.08;
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    const f = 880;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-30 * t);
      data[i] = Math.sin(2 * Math.PI * f * t) * env * 0.9;
    }
    return buf;
  }

  /** Synthesize a strummed chord using Karplus-Strong plucked-string per note, staggered. */
  private buildChord(ctx: AudioContext, freqs: number[]): AudioBuffer {
    const sr = ctx.sampleRate;
    const dur = 1.6;
    const len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    const strumSpan = 0.045; // total strum time low→high (seconds)
    const damping = 0.996;

    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      const startSample = Math.floor(((i / Math.max(1, freqs.length - 1)) * strumSpan) * sr);
      this.pluck(out, startSample, len, sr, f, damping, 0.7 / Math.sqrt(freqs.length));
    }
    // Soft saturation + final smoothing tail.
    for (let i = 0; i < len; i++) {
      let s = out[i];
      s = Math.tanh(s * 1.15);
      out[i] = s;
    }
    return buf;
  }

  /** Karplus-Strong: short noise burst into a delay line with low-pass feedback. */
  private pluck(
    out: Float32Array,
    startSample: number,
    totalLen: number,
    sr: number,
    freq: number,
    damping: number,
    amp: number,
  ): void {
    const N = Math.max(2, Math.round(sr / freq));
    const delay = new Float32Array(N);
    // Excite with short noise burst.
    for (let i = 0; i < N; i++) delay[i] = (Math.random() * 2 - 1);

    let idx = 0;
    let prev = 0;
    const end = Math.min(totalLen, startSample + Math.floor(sr * 1.5));
    for (let n = startSample; n < end; n++) {
      const cur = delay[idx];
      const filt = 0.5 * (cur + prev) * damping;
      prev = cur;
      delay[idx] = filt;
      out[n] += filt * amp;
      idx = (idx + 1) % N;
    }
  }
}

export const audio = new AudioEngine();
