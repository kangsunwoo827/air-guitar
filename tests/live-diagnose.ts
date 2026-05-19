// Diagnose why processFrame never runs on the live deploy.
// Headless Chrome with fake camera. Click START, sample diagnostic state every
// second for ~6 seconds, log everything raw.

import puppeteer from 'puppeteer-core';

const URL = process.env.URL ?? 'https://kangsunwoo827.github.io/air-guitar/';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main(): Promise<void> {
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

  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    const logs: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      const t = msg.type();
      const text = msg.text();
      if (t === 'error') errors.push(`console.error: ${text}`);
      else logs.push(`console.${t}: ${text}`);
    });

    console.log(`URL: ${URL}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });

    // Install a frame-counter on the video element BEFORE the user clicks START.
    await page.evaluate(() => {
      const v = document.getElementById('cam') as HTMLVideoElement;
      // Capture original rvfc, wrap to count.
      type RVFC = (cb: (now: number, m: unknown) => void) => number;
      const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(v);
      (window as unknown as { __diag: { rvfcCalls: number; rvfcFired: number } }).__diag = {
        rvfcCalls: 0,
        rvfcFired: 0,
      };
      if (rvfc) {
        (v as HTMLVideoElement & { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback = function (cb) {
          (window as unknown as { __diag: { rvfcCalls: number; rvfcFired: number } }).__diag.rvfcCalls++;
          return rvfc((now, meta) => {
            (window as unknown as { __diag: { rvfcCalls: number; rvfcFired: number } }).__diag.rvfcFired++;
            cb(now, meta);
          });
        } as RVFC;
      }
    });

    await page.waitForSelector('#start', { visible: true });
    await page.click('#start');

    // Wait up to 15s for status to become "running"; if it errors, capture status.
    const reachedRunning = await page
      .waitForFunction(
        () => /^running$|^ERROR/.test(document.getElementById('status')?.textContent ?? ''),
        { timeout: 15_000 },
      )
      .catch(() => null);
    const initStatus = await page.$eval('#status', (el) => el.textContent ?? '');
    console.log(`status after START click: "${initStatus}" (reachedRunning=${!!reachedRunning})`);

    for (let i = 1; i <= 6; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const snap = await page.evaluate(() => {
        const cam = document.getElementById('cam') as HTMLVideoElement;
        const stats = document.getElementById('stats')?.textContent ?? '';
        const status = document.getElementById('status')?.textContent ?? '';
        const overlay = document.getElementById('overlay') as HTMLCanvasElement;
        const chordLabel = document.getElementById('chord-label')?.textContent ?? '';
        const diag = (window as unknown as { __diag: { rvfcCalls: number; rvfcFired: number } }).__diag;
        // Sample overlay pixels — count non-zero alpha pixels.
        const ctx = overlay.getContext('2d');
        let nonzeroPixels = 0;
        if (ctx && overlay.width > 0 && overlay.height > 0) {
          const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
          for (let p = 3; p < data.length; p += 4) {
            if (data[p] !== 0) nonzeroPixels++;
          }
        }
        return {
          status,
          stats: stats.slice(0, 200),
          chord: chordLabel,
          cam: {
            readyState: cam.readyState,
            vw: cam.videoWidth,
            vh: cam.videoHeight,
            paused: cam.paused,
            ended: cam.ended,
            currentTime: cam.currentTime,
            srcObject: cam.srcObject != null,
            hasRvfc: !!(cam as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback,
          },
          overlay: { width: overlay.width, height: overlay.height, nonzeroPixels },
          diag,
        };
      });
      console.log(`t=${i}s:`, JSON.stringify(snap));
    }

    console.log('\n--- captured pageerrors/console.errors ---');
    if (errors.length === 0) console.log('(none)');
    for (const e of errors) console.log(e);
    console.log('\n--- console.log/info/warn (filtered, last 30) ---');
    for (const l of logs.slice(-30)) console.log(l);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
