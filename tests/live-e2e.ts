// Live e2e: serve dist/ statically, drive it in headless Chrome with a fake
// camera, and inject synthetic hand landmarks via the `__airDiag.forceHands`
// diagnostic hook so the full pipeline (detect → draw → classify → strum)
// runs end-to-end. Surfaces three PASS lines:
//
//   PASS — live_pipeline_e2e = N frames in Mms (drawCalls=K, nonzeroPixels>0)
//   PASS — chord_recognition_e2e = <chord>
//   PASS — live_console_errors = 0
//
// Sequence:
//   1. Run `npm run build` to produce dist/.
//   2. Start a small Node http server on dist/.
//   3. Launch puppeteer-core, point it at http://localhost:<port>/.
//   4. Click START, wait for status=running.
//   5. window.__airDiag.forceHands = (tMs) => [G chord hand (Left), wrist hand (Right)].
//   6. Wait 5 seconds, sample diag + overlay pixel count + #chord-label text.
//   7. Print PASS lines.

import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChordHand } from './fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.E2E_PORT ?? 4321);

function startServer(port: number): Promise<http.Server> {
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    svg: 'image/svg+xml',
    json: 'application/json',
    wasm: 'application/wasm',
  };
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      const filename = url === '/' ? '/index.html' : url;
      const full = path.join(DIST, decodeURIComponent(filename));
      if (!full.startsWith(DIST)) {
        res.writeHead(403); res.end('403'); return;
      }
      fs.readFile(full, (err, data) => {
        if (err) { res.writeHead(404); res.end(`404 ${filename}`); return; }
        const ext = path.extname(full).slice(1);
        res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    s.on('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

// Filter out MediaPipe / TensorFlow informational stderr-as-console.error noise
// that has nothing to do with our code. Anything else is a real error.
function isRealError(text: string): boolean {
  if (/Created TensorFlow Lite XNNPACK delegate/.test(text)) return false;
  if (/^I\d{4} /.test(text)) return false;            // glog INFO
  if (/^W\d{4} /.test(text)) return false;            // glog WARNING
  if (/OpenGL error checking is disabled/.test(text)) return false;
  if (/Feedback manager requires/.test(text)) return false;
  if (/willReadFrequently/.test(text)) return false;
  if (/Graph successfully started running/.test(text)) return false;
  return true;
}

async function main(): Promise<void> {
  console.log('--- live e2e: building dist/ ---');
  // The user can pre-build via `npm run build`; we don't re-shell out here to
  // keep the test script standalone and fast.
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`dist/index.html not found — run \`npm run build\` first (looked at ${DIST})`);
  }

  const server = await startServer(PORT);
  const URL_BASE = `http://127.0.0.1:${PORT}/`;
  console.log(`--- live e2e: serving ${DIST} at ${URL_BASE} ---`);

  // Pre-build the synthetic G chord landmark set in Node land; we'll pass it
  // through puppeteer's evaluate() boundary as plain JSON.
  const gLandmarks = makeChordHand('G');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'shell',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
    ],
  });

  let exitCode = 0;
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && isRealError(msg.text())) {
        errors.push(`console.error: ${msg.text()}`);
      }
    });

    await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#start', { visible: true });
    await page.click('#start');

    await page.waitForFunction(
      () => document.getElementById('status')?.textContent === 'running',
      { timeout: 30_000 },
    );

    // Install forceHands hook. Provide TWO hands:
    //   - Left: G-chord fingering (drives chord classifier)
    //   - Right: wrist that doesn't strum (we test chord-label transition,
    //            not strum events — strum has its own dedicated test)
    await page.evaluate((landmarks) => {
      const w = window as Window & {
        __airDiag?: {
          forceHands?: (tMs: number) => unknown[];
        };
      };
      if (!w.__airDiag) throw new Error('__airDiag not installed on window');
      // Right-hand wrist at a steady y — no strum.
      const rightLm = Array.from({ length: 21 }, () => ({ x: 0.85, y: 0.5, z: 0 }));
      rightLm[0] = { x: 0.85, y: 0.5, z: 0 };
      w.__airDiag.forceHands = (): unknown[] => [
        { landmarks, worldLandmarks: [], handedness: 'Left', score: 0.95 },
        { landmarks: rightLm, worldLandmarks: [], handedness: 'Right', score: 0.95 },
      ];
    }, gLandmarks);

    // Sample every 1s for 5s.
    type Snap = {
      t: number; frameCount: number; drawCalls: number; chord: string | null;
      nonzeroPixels: number; chordLabel: string; lastError: string | null;
    };
    const snaps: Snap[] = [];
    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const snap = await page.evaluate((sec) => {
        const overlay = document.getElementById('overlay') as HTMLCanvasElement;
        const ctx = overlay.getContext('2d');
        let nonzeroPixels = 0;
        if (ctx && overlay.width > 0 && overlay.height > 0) {
          const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
          for (let p = 3; p < data.length; p += 4) if (data[p] !== 0) nonzeroPixels++;
        }
        const w = window as Window & {
          __airDiag?: { frameCount: number; drawCalls: number; lastChord: string | null; lastError: string | null };
        };
        const d = w.__airDiag;
        if (!d) throw new Error('__airDiag missing during sample');
        return {
          t: sec,
          frameCount: d.frameCount,
          drawCalls: d.drawCalls,
          chord: d.lastChord,
          nonzeroPixels,
          chordLabel: document.getElementById('chord-label')?.textContent ?? '',
          lastError: d.lastError,
        };
      }, i);
      snaps.push(snap);
      console.log(`t=${i}s: ${JSON.stringify(snap)}`);
    }

    const last = snaps[snaps.length - 1];
    const totalFrames = last.frameCount;
    const elapsedMs = 5_000;
    const drawCalls = last.drawCalls;
    const nonzero = last.nonzeroPixels;
    const finalChord = last.chord;
    const finalChordLabel = last.chordLabel;

    console.log('\n--- live e2e gates ---');

    // (8) live_pipeline_e2e
    const frameGate = totalFrames >= 30;
    const pixelGate = nonzero > 0;
    const drawGate = drawCalls > 0;
    if (frameGate && pixelGate && drawGate && last.lastError == null) {
      console.log(`PASS — live_pipeline_e2e = ${totalFrames} frames in ${elapsedMs}ms (drawCalls=${drawCalls}, nonzeroPixels=${nonzero}, lastError=null)`);
    } else {
      console.log(`FAIL — live_pipeline_e2e: frames=${totalFrames}(>=30 ${frameGate}), drawCalls=${drawCalls}(>0 ${drawGate}), nonzeroPixels=${nonzero}(>0 ${pixelGate}), lastError=${last.lastError}`);
      exitCode = 1;
    }

    // (9) chord_recognition_e2e
    if (finalChord != null && finalChord !== '' && finalChordLabel !== '—' && finalChordLabel !== '--') {
      console.log(`PASS — chord_recognition_e2e = ${finalChord} (label="${finalChordLabel}")`);
    } else {
      console.log(`FAIL — chord_recognition_e2e: lastChord=${JSON.stringify(finalChord)} label="${finalChordLabel}"`);
      exitCode = 1;
    }

    // Console error gate
    if (errors.length === 0) {
      console.log(`PASS — live_console_errors = 0`);
    } else {
      console.log(`FAIL — live_console_errors = ${errors.length}`);
      for (const e of errors) console.log(`  ${e}`);
      exitCode = 1;
    }
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
