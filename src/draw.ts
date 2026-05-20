import { HAND_CONNECTIONS, type Hand } from './mediapipe';
import {
  CHORD_SHAPES,
  type ChordShape,
  type FingerLabel,
  type FingerState,
  type LocalTips,
} from './chord-rules';
import type { ChordName } from './audio';

// --- Chord-chart geometry ----------------------------------------------------
// Vertical chart, nut on top. String 1 (high e) on the right, string 6 (low E)
// on the left — standard chord-chart convention.
const STRINGS = 6;
const FRETS = 4;
const W = 110;
const H = 132;
const PAD_L = 14;
const PAD_R = 14;
const PAD_T = 22;   // room for X/O markers and the fret-1 label
const PAD_B = 8;
const STRING_GAP = (W - PAD_L - PAD_R) / (STRINGS - 1);
const FRET_GAP = (H - PAD_T - PAD_B) / FRETS;

const stringX = (s: number): number => PAD_L + (STRINGS - s) * STRING_GAP;
const fretMidY = (f: number): number => PAD_T + (f - 0.5) * FRET_GAP;

const fingerColor = (f: FingerLabel): string => ({ I: '#4ad7ff', M: '#ffa666', R: '#7ddc8a', P: '#e7a4ff' })[f];

function chartBackground(): string {
  const right = PAD_L + (STRINGS - 1) * STRING_GAP;
  const bottom = PAD_T + FRETS * FRET_GAP;
  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${W + 14}" height="${H}" fill="none"/>`);
  // Strings (vertical lines).
  for (let s = 1; s <= STRINGS; s++) {
    const x = stringX(s);
    parts.push(
      `<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${bottom}" stroke="#7a8298" stroke-width="1"/>`,
    );
  }
  // Frets (horizontal lines).
  for (let f = 1; f <= FRETS; f++) {
    const y = PAD_T + f * FRET_GAP;
    parts.push(
      `<line x1="${PAD_L}" y1="${y}" x2="${right}" y2="${y}" stroke="#7a8298" stroke-width="1"/>`,
    );
  }
  // Nut (thicker line at fret 0).
  parts.push(
    `<line x1="${PAD_L - 1}" y1="${PAD_T}" x2="${right + 1}" y2="${PAD_T}" stroke="#e6e8ec" stroke-width="3"/>`,
  );
  // Fret-1 label on the right.
  parts.push(
    `<text x="${right + 6}" y="${fretMidY(1) + 3}" fill="#7a8298" font-size="9">1</text>`,
  );
  return parts.join('');
}

function renderShape(shape: ChordShape): string {
  const parts: string[] = [];
  if (shape.barre) {
    const x1 = stringX(shape.barre.from);
    const x2 = stringX(shape.barre.to);
    const lx = Math.min(x1, x2);
    const rx = Math.max(x1, x2);
    const y = fretMidY(shape.barre.fret);
    const color = fingerColor(shape.barre.finger);
    parts.push(
      `<rect x="${lx - 6}" y="${y - 6}" width="${rx - lx + 12}" height="12" rx="6" fill="${color}" opacity="0.9"/>`,
    );
    parts.push(
      `<text x="${(lx + rx) / 2}" y="${y + 3}" fill="#0b0d12" font-size="9" text-anchor="middle" font-weight="700">${shape.barre.finger}</text>`,
    );
  }
  for (const d of shape.dots) {
    const x = stringX(d.string);
    const y = fretMidY(d.fret);
    const color = fingerColor(d.finger);
    parts.push(`<circle cx="${x}" cy="${y}" r="7" fill="${color}"/>`);
    parts.push(
      `<text x="${x}" y="${y + 3}" fill="#0b0d12" font-size="9" text-anchor="middle" font-weight="700">${d.finger}</text>`,
    );
  }
  if (shape.open) {
    for (const s of shape.open) {
      parts.push(
        `<circle cx="${stringX(s)}" cy="${PAD_T - 9}" r="3.5" fill="none" stroke="#aab1c1" stroke-width="1.2"/>`,
      );
    }
  }
  if (shape.muted) {
    for (const s of shape.muted) {
      const x = stringX(s);
      parts.push(
        `<line x1="${x - 3.5}" y1="${PAD_T - 12.5}" x2="${x + 3.5}" y2="${PAD_T - 5.5}" stroke="#aab1c1" stroke-width="1.3"/>`,
      );
      parts.push(
        `<line x1="${x + 3.5}" y1="${PAD_T - 12.5}" x2="${x - 3.5}" y2="${PAD_T - 5.5}" stroke="#aab1c1" stroke-width="1.3"/>`,
      );
    }
  }
  return parts.join('');
}

export function renderExpectedChart(svg: SVGSVGElement, chord: ChordName | null): void {
  svg.setAttribute('viewBox', `0 0 ${W + 14} ${H}`);
  let inner = chartBackground();
  if (chord) {
    inner += renderShape(CHORD_SHAPES[chord]);
  } else {
    inner += `<text x="${(W + 14) / 2}" y="${(PAD_T + H) / 2}" fill="#7a8298" font-size="13" text-anchor="middle">—</text>`;
  }
  svg.innerHTML = inner;
}

// Empirically chosen ranges for tip positions in hand-local space (palm-width
// units). Tips of pressed fingers usually sit inside this box; we clamp to
// avoid the dot leaving the chart when MediaPipe wobbles.
const TIP_X_MIN = -0.45;
const TIP_X_MAX = 0.55;
const TIP_Y_MIN = 0.35;
const TIP_Y_MAX = 1.45;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function tipToChart(tx: number, ty: number): { x: number; y: number } {
  // x_local larger = pinky side = string 1 side (right of chart).
  const xn = (clamp(tx, TIP_X_MIN, TIP_X_MAX) - TIP_X_MIN) / (TIP_X_MAX - TIP_X_MIN);
  const x = PAD_L + xn * (STRINGS - 1) * STRING_GAP;
  // y_local larger = higher fret = further down the chart.
  const yn = (clamp(ty, TIP_Y_MIN, TIP_Y_MAX) - TIP_Y_MIN) / (TIP_Y_MAX - TIP_Y_MIN);
  const y = PAD_T + yn * FRETS * FRET_GAP;
  return { x, y };
}

export function renderDetectedChart(
  svg: SVGSVGElement,
  state: FingerState | null,
  tips: LocalTips | null,
): void {
  svg.setAttribute('viewBox', `0 0 ${W + 14} ${H}`);
  let inner = chartBackground();
  if (state && tips) {
    const items: Array<[FingerLabel, FingerState[keyof FingerState], { x: number; y: number }]> = [
      ['I', state.index, tips.I],
      ['M', state.middle, tips.M],
      ['R', state.ring, tips.R],
      ['P', state.pinky, tips.P],
    ];
    for (const [label, s, tip] of items) {
      const c = tipToChart(tip.x, tip.y);
      if (s === 'press') {
        inner += `<circle cx="${c.x}" cy="${c.y}" r="7" fill="${fingerColor(label)}"/>`;
        inner += `<text x="${c.x}" y="${c.y + 3}" fill="#0b0d12" font-size="9" text-anchor="middle" font-weight="700">${label}</text>`;
      } else if (s === 'ext') {
        inner += `<circle cx="${c.x}" cy="${c.y}" r="4" fill="none" stroke="${fingerColor(label)}" stroke-width="1.4" opacity="0.7"/>`;
      } else {
        // curl: small faded dot
        inner += `<circle cx="${c.x}" cy="${c.y}" r="3" fill="${fingerColor(label)}" opacity="0.25"/>`;
      }
    }
  } else {
    inner += `<text x="${(W + 14) / 2}" y="${(PAD_T + H) / 2}" fill="#7a8298" font-size="11" text-anchor="middle">no hand</text>`;
  }
  svg.innerHTML = inner;
}

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
