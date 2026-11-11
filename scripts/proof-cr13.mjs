// CR13 proof: the built file opened from disk (networking off), desktop 1440 px and phone 375 px.
// BET NOW watermark, cash-out frame, tile counter at 2/91 and 45/91, +/- box, main button, side sections.
//   node scripts/proof-cr13.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser, launch, sleep } from './browser.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = resolve(process.argv[2] ?? resolve(appRoot, 'data/proof-cr13'));
mkdirSync(outDir, { recursive: true });
const file = resolve(appRoot, 'dist/platforman.html');
const b = await launch(findBrowser());
const saved = [];
const rect = (sel) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 900) }; })()`);
const shot = async (name, sel, scale = 2, pad = 0) => {
  const r = sel ? await rect(sel) : null;
  if (sel && !r) return;
  const clip = r ? { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad, scale } : undefined;
  const s = await b.cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  const p = resolve(outDir, `${name}.png`);
  writeFileSync(p, Buffer.from(s.result.data, 'base64'));
  saved.push(p);
};
const line2 = `(document.querySelectorAll('.msgbox .msg-line')[1]?.textContent ?? '')`;
for (const [view, m] of [
  ['desktop', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }],
  ['phone', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }],
]) {
  await b.cdp('Emulation.setDeviceMetricsOverride', m);
  await b.cdp('Page.navigate', { url: pathToFileURL(file).href });
  await sleep(1500);
  await b.waitFor(`!!document.querySelector('.betnow') && !document.querySelector('.loading')`, 60_000, 'betting');
  await sleep(300);
  await shot(`${view}-1-betting-full`);
  await shot(`${view}-2-amount-box`, '.amount-group', 4, 4);
  await shot(`${view}-3-main-button`, '.mainbtn', 3, 2);
  // Bet by tapping the framed tile again, then cash out after the 2nd tile.
  await b.evaluate(`document.querySelector('.tile.picked').click(), true`);
  await b.waitFor(`/^Tiles 2\\//.test(${line2})`, 30_000, 'tile 2');
  await shot(`${view}-4-counter-2of91`, '.msgbox', 4);
  await b.evaluate(`(() => { const x = document.querySelector('.mainbtn'); if (/^Cash out/.test(x.textContent)) x.click(); return true; })()`);
  await sleep(500);
  await shot(`${view}-5-cashout-frame`, '.under', 2, 6);
  await b.waitFor(`/^Tiles 45\\//.test(${line2})`, 60_000, 'tile 45');
  await shot(`${view}-6-counter-45of91`, '.msgbox', 4);
  if (view === 'desktop') {
    await shot(`${view}-7-live-bets`, '.left-col', 2);
    // History: switch to 24h after a round has finished so the sort buttons show.
    await b.waitFor(`!/No rounds/.test(document.querySelector('.rounds tbody')?.textContent ?? 'No rounds')`, 240_000, 'history');
    await b.evaluate(`[...document.querySelectorAll('.rp-tab')].find((t) => t.textContent === '24h').click(), true`);
    await sleep(300);
    await shot(`${view}-8-history-24h`, '.right-col', 2);
    await b.evaluate(`[...document.querySelectorAll('.sortbtn')].find((t) => t.textContent.startsWith('Win')).click(), true`);
    await sleep(200);
    await shot(`${view}-9-history-sorted-by-win`, '.right-col', 2);
  }
}
const info = await b.evaluate(`({ th: [...document.querySelectorAll('.rounds th')].map((t) => t.firstChild?.textContent?.trim()), cta: getComputedStyle(document.querySelector('.mainbtn .cta')).fontWeight, scrollbar: getComputedStyle(document.querySelector('.tablewrap')).scrollbarWidth })`);
writeFileSync(resolve(outDir, 'report.json'), JSON.stringify({ file, saved, info, external: b.external(), consoleErrors: b.consoleErrors }, null, 2));
console.log(JSON.stringify({ saved, info, external: b.external(), consoleErrors: b.consoleErrors }, null, 2));
b.close();
process.exit(0);
