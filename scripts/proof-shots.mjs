// Screenshots of the delivered dist/platforman.html opened from disk with networking disabled, at desktop and
// phone widths, plus zoomed crops and computed font data. Used as proof that fixes are visible in the build.
//   node scripts/proof-shots.mjs [outDir] [--file=path] [--tag=name]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser, launch, sleep } from './browser.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const outDir = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : resolve(appRoot, 'data/proof'));
const file = process.argv.find((a) => a.startsWith('--file='))?.slice(7) ?? resolve(appRoot, 'dist/platforman.html');
const tag = process.argv.find((a) => a.startsWith('--tag='))?.slice(6) ?? 'platforman';
mkdirSync(outDir, { recursive: true });
const b = await launch(findBrowser());
const shot = async (name, clip) => {
  const r = await b.cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: clip.scale ?? 3 } } : {}) });
  const p = resolve(outDir, `${tag}-${name}.png`);
  writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
};
const rect = async (sel) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
const report = { file, views: {} };
for (const [view, metrics] of [
  ['desktop', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }],
  ['phone', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }],
]) {
  await b.cdp('Emulation.setDeviceMetricsOverride', metrics);
  await b.cdp('Page.navigate', { url: pathToFileURL(file).href });
  await sleep(1500);
  const isGame = await b.evaluate(`!!document.querySelector('.board')`);
  const v = { shots: [] };
  if (isGame) {
    // Wait for betting to be open and the loading screen gone, so BET NOW and the framed tile show.
    await b.waitFor(`!!document.querySelector('.betnow') && !document.querySelector('.loading')`, 60_000, 'betting').catch(() => {});
    await sleep(400);
    v.fonts = await b.evaluate(`(async () => {
      await document.fonts.ready;
      const cs = (sel) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e); return { family: c.fontFamily.split(',')[0], weight: c.fontWeight, size: c.fontSize, letterSpacing: c.letterSpacing }; };
      return {
        check400: document.fonts.check('400 16px Montserrat'), check700: document.fonts.check('700 16px Montserrat'), check800: document.fonts.check('800 16px Montserrat'),
        faces: [...document.fonts].map((f) => f.family + ' ' + f.weight + ' ' + f.status),
        body: cs('body'), header: cs('.brand'), multiplier: cs('.mbox .mult'), message: cs('.msg-line'), mainButton: cs('.mainbtn .cta'), amount: cs('.amount-group .amount'),
        liveBets: cs('.lbtable td'), tileNumber: cs('.tile-count'), betNow: cs('.betnow span'), tileTag: cs('.tag-bet'),
      };
    })()`);
    v.shots.push(await shot(`${view}-full`));
    const amount = await rect('.amount-group');
    if (amount) v.shots.push(await shot(`${view}-amount-zoom`, { x: amount.x - 4, y: amount.y - 4, width: amount.width + 8, height: amount.height + 8, scale: 4 }));
    const mbox = await rect('.under');
    if (mbox) v.shots.push(await shot(`${view}-lower-zoom`, { ...mbox, scale: 2 }));
    const picked = await rect('.tile.picked');
    if (picked) v.shots.push(await shot(`${view}-framed-tile-zoom`, { x: picked.x - 6, y: picked.y - 6, width: picked.width + 12, height: picked.height + 12, scale: 5 }));
    // Mid-round: the tile counter on message line 2.
    await b.waitFor(`/^Tiles/.test(document.querySelectorAll('.msgbox .msg-line')[1]?.textContent ?? '')`, 20_000, 'running').catch(() => {});
    await sleep(1200);
    const msg = await rect('.msgbox');
    if (msg) v.shots.push(await shot(`${view}-counter-zoom`, { ...msg, scale: 4 }));
    v.counterText = await b.evaluate(`document.querySelectorAll('.msgbox .msg-line')[1]?.textContent ?? ''`);
    v.steps = await b.evaluate(`[...document.querySelectorAll('.amount-group .step')].map((s) => { const r = s.getBoundingClientRect(); const c = getComputedStyle(s); return { w: Math.round(r.width), h: Math.round(r.height), bg: c.backgroundColor, color: c.color, borderL: c.borderLeftWidth + ' ' + c.borderLeftColor, borderR: c.borderRightWidth + ' ' + c.borderRightColor, svg: s.querySelector('svg')?.outerHTML.length ?? 0 }; })`);
  } else {
    v.fonts = await b.evaluate(`(async () => { await document.fonts.ready; const c = getComputedStyle(document.body); return { family: c.fontFamily, faces: [...document.fonts].map((f) => f.family + ' ' + f.weight + ' ' + f.status) }; })()`);
    v.shots.push(await shot(`${view}-full`));
  }
  report.views[view] = v;
}
report.external = b.external();
report.consoleErrors = b.consoleErrors;
writeFileSync(resolve(outDir, `${tag}-report.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
b.close();
process.exit(0);
