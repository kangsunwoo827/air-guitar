import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

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
  private landmarker!: HandLandmarker;
  private lastTimestamp = 0;

  async init(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
    // Use CPU delegate by default. GPU is ~3x faster but some Chrome configs
    // can't create a WebGL context inside the MediaPipe WASM renderer process
    // (the user-side `emscripten_webgl_create_context() returned error 0`
    //  / "Service kGpuService was not provided" failure). The error from the
    // GPU delegate is logged to console without throwing, so detectForVideo
    // can't reliably probe it — running on CPU side-steps the issue entirely.
    // Pass `?gpu=1` in the URL to opt back into the GPU delegate.
    const wantGpu = new URLSearchParams(location.search).has('gpu');
    const delegate: 'GPU' | 'CPU' = wantGpu ? 'GPU' : 'CPU';
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  detect(video: HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap, nowMs: number): FrameDetection {
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
      // MediaPipe reports handedness from the camera's POV; with a mirrored preview
      // the user's real-world hand is the opposite of what's reported. Flip it.
      const rawLabel = cat?.categoryName ?? 'Right';
      const handedness: 'Left' | 'Right' = rawLabel === 'Left' ? 'Right' : 'Left';
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
