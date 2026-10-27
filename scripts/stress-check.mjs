// In-page stress mode, automated: opens dist/last-tile-standing.html from disk (networking blocked), enters the room,
// presses the overlay's "Stress test (9,900 bots)" button for N rounds and prints the recorder's result.
//
//   node scripts/stress-check.mjs [rounds=5] [--headed] [--cpu=4] [--browser=path]
//   --cpu=N throttles the page main thread N times (DevTools CPU throttling) as a slower-laptop proxy.
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser, launch, setInput, sleep } from './browser.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const file = resolve(appRoot, 'dist/last-tile-standing.html');
if (!existsSync(file)) throw new Error('run `npm run build` first');
const rounds = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 5);
const headed = process.argv.includes('--headed');
const browserPath = findBrowser(process.argv.find((a) => a.startsWith('--browser='))?.slice(10));
const cpu = Number(process.argv.find((a) => a.startsWith('--cpu='))?.slice(6) ?? 1);
const b = await launch(browserPath, { headed });
if (cpu > 1) await b.cdp('Emulation.setCPUThrottlingRate', { rate: cpu });
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

await b.cdp('Page.navigate', { url: `${pathToFileURL(file).href}?perf` });
await b.waitFor(`!!document.querySelector('.board .tile')`, 20_000, 'room view');
await b.waitFor(`!!document.querySelector('.perf .num')`, 10_000, 'overlay');
await b.evaluate(setInput('.perf .num', String(rounds)));
await sleep(100);
await b.evaluate(`[...document.querySelectorAll('.perf button')].find((x) => x.textContent.startsWith('Stress test')).click(), true`);
log(`stress test started (${headed ? 'headed' : 'headless'}, cpu x${cpu}): 9,900 bots, ${rounds} rounds`);

for (;;) {
  const r = await b.evaluate('window.__p3stress ? JSON.stringify(window.__p3stress) : null');
  if (r) {
    const report = { ...JSON.parse(r), browser: browserPath, headless: !headed, cpuThrottle: cpu, consoleErrors: b.consoleErrors, externalRequests: b.external() };
    writeFileSync(resolve(appRoot, `data/stress-check-${headed ? 'headed' : 'headless'}-cpu${cpu}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    break;
  }
  log(await b.evaluate(`document.querySelector('.perf')?.innerText.split('\\n').join(' | ')`));
  await sleep(20_000);
}
b.close();
