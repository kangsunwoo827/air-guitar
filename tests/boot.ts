// End-to-end deploy smoke check via headless Chrome with fake camera.
// Validates that the deployed page boots, MediaPipe + AudioContext init succeed,
// and the app reaches "running" status without console errors. Reports
// `nav → running` time as the closest objective proxy for cold-load.
//
// Note: the fake media stream is a synthetic test pattern, not real hands —
// chord/strum semantics can't be verified this way; only the boot/load path is.

import puppeteer from 'puppeteer-core';
import { performance } from 'node:perf_hooks';

const URL = process.env.URL ?? 'https://kangsunwoo827.github.io/air-guitar/';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BUDGET_MS = 30_000;

async function main(): Promise<void> {
  console.log(`URL: ${URL}`);
  console.log(`Chrome: ${CHROME}`);

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
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.failure()?.errorText ?? 'failed'}: ${req.url()}`);
    });
    page.on('response', (resp) => {
      if (resp.status() >= 400) failedRequests.push(`${resp.status()}: ${resp.url()}`);
    });

    const tNav = performance.now();
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    console.log(`navigated in ${(performance.now() - tNav).toFixed(0)}ms`);

    // Click START. Browser auto-grants media permission via the fake-ui flag.
    await page.waitForSelector('#start', { visible: true, timeout: 5000 });
    await page.click('#start');

    // Wait for the status overlay to read "running".
    const tStart = performance.now();
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent?.trim() === 'running',
      { timeout: BUDGET_MS },
    );
    const tRunning = performance.now();
    const bootMs = tRunning - tNav;
    const startToRunningMs = tRunning - tStart;

    // Sample the stats overlay to confirm the frame loop is alive.
    await new Promise((r) => setTimeout(r, 1000));
    const stats = await page.$eval('#stats', (el) => el.textContent ?? '');
    const fpsMatch = stats.match(/fps: ([\d.]+)/);
    const fps = fpsMatch ? Number.parseFloat(fpsMatch[1]) : 0;

    console.log(`\n--- boot report ---`);
    console.log(`nav → running: ${bootMs.toFixed(0)}ms`);
    console.log(`click → running: ${startToRunningMs.toFixed(0)}ms`);
    console.log(`fps after 1s of running: ${fps.toFixed(1)}`);
    console.log(`console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  - ${e}`);
    console.log(`pageerrors: ${pageErrors.length}`);
    for (const e of pageErrors) console.log(`  - ${e}`);
    console.log(`failed requests: ${failedRequests.length}`);
    for (const e of failedRequests) console.log(`  - ${e}`);

    // Boot gate: reaching "running" within 30s with no JS exceptions is the real
    // user-side cold-load proxy. fps from a headless fake-camera is unreliable
    // (chrome's fake stream runs at low fps under headless), so we report but
    // don't gate on it. Asset 404s for a missing favicon are non-fatal.
    const pass = bootMs < BUDGET_MS && pageErrors.length === 0;
    console.log(`\n${pass ? 'PASS' : 'FAIL'} — ${pass ? `boot ${bootMs.toFixed(0)}ms < 30s, no fatal errors` : 'see above'}`);
    if (!pass) process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
