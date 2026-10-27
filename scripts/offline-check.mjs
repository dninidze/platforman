// Opens dist/last-tile-standing.html from disk in headless Chrome/Edge with networking disabled
// (DevTools offline emulation + an unreachable proxy + DNS mapped to nowhere) and checks, through the UI:
//   - §0.2: <title> and header read "Last Tile Standing"; stage tabs read "Stage 1/2/3"
//   - §0.1: no name prompt; a generated demo name is shown; a reload keeps it; "New demo identity"
//           changes it; public lists show masked names only; ?token=abc&currency=USD uses the aggregator
//           provider and shows USD
//   - a full round plays (join → bet → cash out after the first removal if still standing → round end)
//     and the Fairness verifier passes for it
//   - the engine runs in the Web Worker and the page makes no network request
//
//   node scripts/offline-check.mjs [--browser=path]
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser, launch, sleep } from './browser.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const file = resolve(appRoot, 'dist/last-tile-standing.html');
if (!existsSync(file)) throw new Error('run `npm run build` first');
const url = pathToFileURL(file).href;
const browserPath = findBrowser(process.argv.find((a) => a.startsWith('--browser='))?.slice(10));
const b = await launch(browserPath);
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const NAME_RE = /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/;
const playerName = () => b.evaluate(`[...document.querySelectorAll('.stat')].find((s) => s.querySelector('.stat-label')?.textContent.startsWith('Player'))?.querySelector('.stat-value')?.textContent ?? null`);
const open = async (u) => {
  await b.cdp('Page.navigate', { url: u });
  await sleep(300);
  await b.waitFor(`!!document.querySelector('.board .tile') && !!window.__p3session?.()`, 20_000, 'room view');
};

// ---- load, identity, title, labels
await open(url);
const env = await b.evaluate(`({ online: navigator.onLine, secure: isSecureContext, webCrypto: !!crypto.subtle, title: document.title, header: document.querySelector('.brand')?.textContent.replace(/^[^A-Za-z]+/, '').trim(), prompt: !!document.querySelector('input#nick, .join-card input'), engine: window.__p3engine(), session: window.__p3session(), stages: [...document.querySelectorAll('.stage-pill')].map((p) => p.textContent) })`);
log(`loaded: ${JSON.stringify({ ...env, session: { ...env.session, playerId: env.session.playerId.slice(0, 12) + '…' } })}`);
check('networking disabled (navigator.onLine is false)', env.online === false);
check('title and header are "Last Tile Standing"', env.title === 'Last Tile Standing' && env.header === 'Last Tile Standing', `${env.title} / ${env.header}`);
check('stage tabs read Stage 1/2/3', env.stages.join(',') === 'Stage 1,Stage 2,Stage 3', env.stages.join(','));
check('no name prompt: opens straight into the room', !env.prompt);
const name1 = await playerName();
check('generated demo name shown in the header', NAME_RE.test(name1 ?? '') && env.session.provider === 'demo', name1);
check('engine runs in the Web Worker', env.engine === 'web worker', env.engine);

await open(url);
const name2 = await playerName();
check('reload keeps the same name and id', name2 === name1 && (await b.evaluate('window.__p3session().playerId')) === env.session.playerId, name2);

// ---- full round
await b.waitFor(`(() => { const m = (document.querySelector('.phase-label')?.textContent || '').match(/Betting closes in ([\\d.]+)s/); return m && Number(m[1]) > 4; })()`, 240_000, 'betting phase');
const roundId = await b.evaluate(`window.__p3round = document.querySelector('.stat-value') && [...document.querySelectorAll('.stat')].find((s) => s.querySelector('.stat-label')?.textContent === 'Round')?.querySelector('.stat-value')?.textContent`);
log(`betting open for round #${roundId}`);
await b.evaluate(`(() => { const t = [...document.querySelectorAll('.board .tile')].find((x) => !x.disabled && /: \\d+ players/.test(x.getAttribute('aria-label')) && !x.classList.contains('full')); t.click(); return true; })()`);
await sleep(200);
await b.evaluate(`[...document.querySelectorAll('.betpanel button')].find((x) => x.textContent.startsWith('Bet '))?.click(), true`);
await b.waitFor(`/Cancel bet/.test(document.querySelector('.betpanel')?.textContent || '')`, 5_000, 'bet accepted');
await b.waitFor(`/Tiles going|finishing fast/.test(document.querySelector('.phase-label')?.textContent || '')`, 15_000, 'running');
await b.waitFor(`(() => { const x = [...document.querySelectorAll('.betpanel button')].find((y) => y.textContent.startsWith('Cash out €')); if (x && !x.disabled) { x.click(); return true; } return /went Gone|Cashed out/.test(document.querySelector('.betpanel')?.textContent || ''); })()`, 15_000, 'cashout or loss');
await sleep(800);
const outcome = await b.evaluate(`document.querySelector('.betpanel')?.textContent`);
log(`outcome: ${outcome}`);
const feed = await b.evaluate(`[...document.querySelectorAll('.feed li')].map((li) => li.querySelector('.nick')?.textContent).filter(Boolean)`);
const masked = feed.every((n) => /^(You \()?[A-Za-z][A-Za-z]\*\*\*\w\)?$/.test(n));
check('live feed shows only masked names', feed.length > 0 && masked, feed.slice(0, 4).join(', '));
// The feed lists the top 8 cashouts by amount, so ours only appears when it is big enough.
const amounts = await b.evaluate(`[...document.querySelectorAll('.feed li .amt')].map((a) => Number(a.textContent.replace(/[^\\d.]/g, '')))`);
const mine = Number((outcome.match(/Cashed out: \D*([\d,.]+)/)?.[1] ?? 'NaN').replace(/,/g, ''));
const shouldShow = Number.isFinite(mine) && (amounts.length < 8 || mine > Math.min(...amounts));
if (shouldShow) check('own cashout highlighted as "You"', feed.some((n) => n.startsWith('You (')), feed.find((n) => n.startsWith('You (')) ?? 'none');
else log(`(own cashout ${mine} is below the top-8 feed cut-off ${Math.min(...amounts)}; "You" highlight not applicable)`);
await b.waitFor(`/Next round in/.test(document.querySelector('.phase-label')?.textContent || '')`, 300_000, 'round end');
const end = await b.evaluate(`({ overlay: document.querySelector('.overlay.ended')?.textContent, history: document.querySelector('.history li')?.textContent })`);
log(`round over: ${JSON.stringify(end)}`);
check('round played to the end', !!end.overlay && !!end.history);
check('round history uses the stage label', /Stage \d|won 10,000x/.test(end.history ?? ''), end.history);

await b.evaluate(`document.querySelector('[aria-label="Provably fair: verify rounds"]').click(), true`);
await b.waitFor(`!!document.querySelector('.verify-row select')`, 5_000, 'fairness modal');
await b.evaluate(`(() => { const s = document.querySelector('.verify-row select'); const v = [...s.options].map((o) => o.value).find((x) => x.endsWith('#${roundId}')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, v); s.dispatchEvent(new Event('change', { bubbles: true })); return v; })()`);
await sleep(200);
await b.evaluate(`document.querySelector('.verify-row button').click(), true`);
await b.waitFor(`!!document.querySelector('.verdict')`, 10_000, 'verdict');
const verdict = await b.evaluate(`({ title: document.querySelector('#fair-title').textContent, verdict: document.querySelector('.verdict').textContent, checks: [...document.querySelectorAll('.checks li')].map((l) => l.textContent) })`);
check('fairness verifier passes (Web Crypto) for the round played', verdict.verdict.includes('Verified') && verdict.checks.every((c) => c.startsWith('✔')), verdict.verdict);
check('fairness modal titled with the game title', verdict.title.startsWith('Last Tile Standing'), verdict.title);
await b.evaluate(`document.querySelector('.modal-head button').click(), true`);

// ---- new demo identity
await b.evaluate(`document.querySelector('[aria-label="Settings"]').click(), true`);
await b.waitFor(`[...document.querySelectorAll('.modal button')].some((x) => x.textContent === 'New demo identity')`, 5_000, 'settings');
await b.evaluate(`[...document.querySelectorAll('.modal button')].find((x) => x.textContent === 'New demo identity').click(), true`);
await sleep(500);
await b.waitFor(`!!document.querySelector('.board .tile') && !!window.__p3session?.()`, 20_000, 'room after new identity');
const name3 = await playerName();
check('"New demo identity" regenerates the name', NAME_RE.test(name3 ?? '') && name3 !== name1, `${name1} → ${name3}`);

// ---- aggregator launch
await open(`${url}?token=abc&currency=USD`);
const agg = await b.evaluate(`({ session: window.__p3session(), balance: [...document.querySelectorAll('.stat')].find((s) => s.querySelector('.stat-label')?.textContent === 'Balance')?.querySelector('.stat-value')?.textContent, name: document.querySelectorAll('.stat-value')[0]?.textContent })`);
check('?token=abc&currency=USD goes through the aggregator provider and shows USD', agg.session.provider === 'aggregator' && agg.session.currency === 'USD' && agg.balance.startsWith('$'), `${agg.session.provider}, ${agg.session.currency}, ${agg.balance}, ${agg.session.displayName}`);

const external = b.external();
check('no network requests', external.length === 0, external.join(' '));
check('no console errors', b.consoleErrors.length === 0, b.consoleErrors.slice(0, 3).join(' | '));
const report = { url, browser: browserPath, env: { ...env, session: undefined }, roundId, outcome, end, verdict, checks, requests: b.requests.length, externalRequests: external, consoleErrors: b.consoleErrors, seconds: (Date.now() - t0) / 1000 };
writeFileSync(resolve(appRoot, 'data/offline-check.json'), JSON.stringify(report, null, 2));
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `FAIL: ${failed.map((c) => c.name).join('; ')}` : `PASS: all ${checks.length} checks, full round played from disk with networking disabled`);
b.close();
process.exit(failed.length ? 1 : 0);
