// Drives the in-browser ?perf-test=1 self-test in headless Chrome and prints the
// measured audio scheduling + MediaPipe inference latencies. These bound the
// "code path" portion of end-to-end gesture-to-sound latency; the remaining
// component is the user's camera capture delay, which we cannot probe remotely.

import puppeteer from 'puppeteer-core';

const URL = (process.env.URL ?? 'https://kangsunwoo827.github.io/air-guitar/') + '?perf-test=1';
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
    page.on('pageerror', (err) => console.error('pageerror:', err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('console.error:', msg.text());
    });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#start', { visible: true });
    await page.click('#start');
    await page.waitForFunction(
      () => /^perf-done /.test(document.getElementById('status')?.textContent ?? ''),
      { timeout: 60_000 },
    );

    const status = await page.$eval('#status', (el) => el.textContent ?? '');
    const stats = await page.$eval('#stats', (el) => el.textContent ?? '');
    const title = await page.title();

    console.log('--- perf self-test report ---');
    console.log('status:', status);
    console.log(stats);
    console.log('title:', title);

    // Parse "total_avg=NNNms"
    const m = title.match(/total_avg=(\d+)ms.*total_max=(\d+)ms/);
    if (!m) {
      console.error('could not parse total_avg/total_max from title');
      process.exit(2);
    }
    const totalAvg = Number.parseInt(m[1], 10);
    const totalMax = Number.parseInt(m[2], 10);
    const pass = totalAvg < 150 && totalMax < 200;
    console.log(`\n${pass ? 'PASS' : 'FAIL'} — total_avg ${totalAvg}ms (<150ms gate)  total_max ${totalMax}ms`);
    if (!pass) process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
