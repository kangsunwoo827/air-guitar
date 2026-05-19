import { HAND_CONNECTIONS, type Hand } from './mediapipe';

export function drawHands(ctx: CanvasRenderingContext2D, hands: Hand[]): void {
  const { width: w, height: h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  for (const hand of hands) {
    const color = hand.handedness === 'Left' ? '#7ad7ff' : '#ffb86b';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;

    // bones
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const la = hand.landmarks[a];
      const lb = hand.landmarks[b];
      ctx.moveTo(la.x * w, la.y * h);
      ctx.lineTo(lb.x * w, lb.y * h);
    }
    ctx.stroke();

    // joints
    for (const p of hand.landmarks) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // label
    const wrist = hand.landmarks[0];
    ctx.fillStyle = color;
    ctx.font = '700 14px system-ui';
    ctx.fillText(hand.handedness, wrist.x * w + 8, wrist.y * h + 16);
  }
}

export function sizeCanvasTo(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
