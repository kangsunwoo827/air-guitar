// Measures the cold-load asset budget for the deployed app.
// We can't truly simulate "time to first sound" without a real browser+camera,
// but we can measure the network cost of every resource the cold path needs:
//   index.html, the Vite bundle (JS + CSS), the MediaPipe WASM, and the hand-landmarker model.
// If the cumulative sequential fetch is well under the 30s budget, the user-side
// cold-load is dominated by network + their device, not by anything we control.

import { performance } from 'node:perf_hooks';

const ORIGIN = 'https://kangsunwoo827.github.io/air-guitar/';
const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.wasm';
const MEDIAPIPE_LOADER = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.js';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

type FetchResult = { url: string; status: number; bytes: number; ms: number };

async function timed(url: string): Promise<FetchResult> {
  const t0 = performance.now();
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const ms = performance.now() - t0;
  return { url, status: res.status, bytes: buf.byteLength, ms };
}

function extractAssetUrls(html: string, base: string): string[] {
  const urls = new Set<string>();
  const scriptRe = /<script[^>]*src="([^"]+)"/g;
  const linkRe = /<link[^>]*href="([^"]+\.css)"/g;
  let m;
  while ((m = scriptRe.exec(html))) urls.add(new URL(m[1], base).toString());
  while ((m = linkRe.exec(html))) urls.add(new URL(m[1], base).toString());
  return [...urls];
}

async function main(): Promise<void> {
  const results: FetchResult[] = [];

  console.log(`fetching: ${ORIGIN}`);
  const indexT0 = performance.now();
  const indexRes = await fetch(ORIGIN);
  const html = await indexRes.text();
  const indexMs = performance.now() - indexT0;
  results.push({ url: ORIGIN, status: indexRes.status, bytes: html.length, ms: indexMs });

  if (indexRes.status !== 200) {
    console.error(`index.html returned ${indexRes.status}`);
    process.exit(1);
  }

  const assets = extractAssetUrls(html, ORIGIN);
  console.log(`assets in HTML: ${assets.length}`);
  // Sequential fetch (worst-case dependency chain).
  for (const u of assets) {
    const r = await timed(u);
    results.push(r);
  }

  // External CDN/model fetches.
  for (const u of [MEDIAPIPE_LOADER, MEDIAPIPE_WASM, MODEL_URL]) {
    const r = await timed(u);
    results.push(r);
  }

  const totalMs = results.reduce((a, b) => a + b.ms, 0);
  const totalBytes = results.reduce((a, b) => a + b.bytes, 0);

  console.log('\n--- cold-load report ---');
  for (const r of results) {
    console.log(
      `${String(r.status).padEnd(4)} ${(r.bytes / 1024).toFixed(1).padStart(8)} KB  ${r.ms.toFixed(0).padStart(6)} ms  ${r.url}`,
    );
  }
  const seconds = (totalMs / 1000).toFixed(2);
  console.log(`\nTOTAL: ${(totalBytes / 1024).toFixed(1)} KB across ${results.length} requests, ${seconds}s sequential`);
  console.log(`BUDGET: 30s (page entry → first sound)`);
  if (totalMs < 30000) {
    console.log(`PASS — ${seconds}s < 30s`);
  } else {
    console.log(`FAIL — exceeded budget`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
