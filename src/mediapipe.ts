import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export type InitProgress = {
  phase: 'wasm' | 'model' | 'graph' | 'probe' | 'fallback' | 'ready';
  message: string;
  pct?: number;        // 0..100 when known
  delegate?: 'GPU' | 'CPU';
};
export type ProgressFn = (p: InitProgress) => void;


export type Landmark = { x: number; y: number; z: number };
export type Hand = {
  landmarks: Landmark[];          // 21 normalized landmarks
  worldLandmarks: Landmark[];     // 21 metric landmarks (meters, hand-centered)
  handedness: 'Left' | 'Right';
  score: number;
};

export type FrameDetection = {
  hands: Hand[];
  timestampMs: number;
  detectMs: number;   // time from frame submit to result
};

export class HandTracker {
  private landmarker?: HandLandmarker;
  private lastTimestamp = 0;
  private activeDelegate: 'GPU' | 'CPU' = 'CPU';

  delegate(): 'GPU' | 'CPU' {
    return this.activeDelegate;
  }

  ready(): boolean {
    return this.landmarker !== undefined;
  }

  /** Release the underlying HandLandmarker (and its GL context / model
   *  memory) so a subsequent init() doesn't pile up leaked WebGL contexts.
   *  Each unclosed HandLandmarker holds an active WebGL context, and Chrome
   *  caps the per-page total around 16 — past that, the next detect() fails
   *  with confusing GL errors. Safe to call when already closed. */
  close(): void {
    if (this.landmarker) {
      try {
        this.landmarker.close();
      } catch {
        /* swallow — best-effort cleanup */
      }
      this.landmarker = undefined;
    }
    this.lastTimestamp = 0;
  }

  async init(onProgress?: ProgressFn): Promise<void> {
    // Release any prior landmarker so we don't leak its GL context.
    this.close();

    const progress: ProgressFn = onProgress ?? ((): void => undefined);
    progress({ phase: 'wasm', message: 'MediaPipe WASM 로딩...' });
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);

    // We deliberately do NOT prefetch MODEL_URL with our own fetch even
    // though that would give us a percentage. Doing so triggers a second
    // request for the same Google Cloud Storage object — without
    // Cache-Control headers GCS lets both requests go to network, and the
    // overlap appears to corrupt MediaPipe's internal model load (observed:
    // `Cannot read properties of undefined (reading 'activeTexture')` on
    // the first detect). Let MediaPipe own the fetch; show an
    // indeterminate "모델 로딩" while it works.
    progress({ phase: 'model', message: '모델 로딩 (~12MB, 첫 로드만)...' });

    // Default CPU. `?gpu=1` opt-in for users who know GPU works on their setup.
    const wantGpu = new URLSearchParams(location.search).get('gpu') === '1';
    const delegate: 'GPU' | 'CPU' = wantGpu ? 'GPU' : 'CPU';
    progress({ phase: 'graph', message: `${delegate} graph 시작...`, delegate });
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    this.activeDelegate = delegate;
    progress({ phase: 'ready', message: `ready (${delegate})`, delegate });
  }

  detect(video: HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap, nowMs: number): FrameDetection {
    if (!this.landmarker) {
      throw new Error('HandTracker.detect called before init / after close');
    }
    // detectForVideo requires monotonically increasing timestamps.
    let ts = Math.floor(nowMs);
    if (ts <= this.lastTimestamp) ts = this.lastTimestamp + 1;
    this.lastTimestamp = ts;

    const t0 = performance.now();
    const result: HandLandmarkerResult = this.landmarker.detectForVideo(video, ts);
    const detectMs = performance.now() - t0;

    const hands: Hand[] = [];
    const n = result.landmarks?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const cat = result.handedness[i]?.[0];
      // MediaPipe's handedness convention assumes a mirrored (selfie) input
      // image — i.e., it reports the *user's* real-world handedness as long
      // as the input stream is already flipped. On the setups we ship for
      // (Chrome / desktop webcam, raw stream into MediaPipe, CSS-only mirror
      // for the preview), MediaPipe's label matches the user's real hand
      // directly, so we use it as-is. If a particular setup gets it reversed,
      // pressing `S` swaps which side feeds the chord vs the strum logic.
      const rawLabel = cat?.categoryName ?? 'Right';
      const handedness: 'Left' | 'Right' = rawLabel === 'Left' ? 'Left' : 'Right';
      hands.push({
        landmarks: result.landmarks[i] as Landmark[],
        worldLandmarks: result.worldLandmarks?.[i] as Landmark[] ?? [],
        handedness,
        score: cat?.score ?? 0,
      });
    }
    return { hands, timestampMs: ts, detectMs };
  }
}

export const HAND_CONNECTIONS: ReadonlyArray<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],          // index
  [5, 9], [9, 10], [10, 11], [11, 12],     // middle
  [9, 13], [13, 14], [14, 15], [15, 16],   // ring
  [13, 17], [17, 18], [18, 19], [19, 20],  // pinky
  [0, 17],                                  // palm base
];
