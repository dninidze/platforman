// Opens dist/platforman.html from disk in headless Chrome/Edge with networking disabled
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
const file = resolve(appRoot, 'dist/platforman.html');
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
check('title and header are "Platforman"', env.title === 'Platforman' && env.header === 'Platforman', `${env.title} / ${env.header}`);
check('stage tabs read Vol. 1/2/3', env.stages.join(',') === 'Vol. 1,Vol. 2,Vol. 3', env.stages.join(','));
check('no name prompt: opens straight into the room', !env.prompt);
const name1 = await playerName();
check('generated demo name shown in the header', NAME_RE.test(name1 ?? '') && env.session.provider === 'demo', name1);
check('engine runs in the Web Worker', env.engine === 'web worker', env.engine);

await open(url);
const name2 = await playerName();
check('reload keeps the same name and id', name2 === name1 && (await b.evaluate('window.__p3session().playerId')) === env.session.playerId, name2);

// ---- full round (CHANGES_4 §2 main-button flow)
const mainBtn = `document.querySelector('.mainbtn')`;
await b.waitFor(`(() => { const m = (document.querySelector('.mstatus')?.textContent || '').match(/Betting closes in ([\\d.]+) s/); return m && Number(m[1]) > 4; })()`, 240_000, 'betting phase');
const roundId = await b.evaluate(`[...document.querySelectorAll('.stat')].find((s) => s.querySelector('.stat-label')?.textContent === 'Round')?.querySelector('.stat-value')?.textContent`);
log(`betting open for round #${roundId}`);
const auto = await b.evaluate(`({ text: ${mainBtn}.textContent, cls: ${mainBtn}.className, picked: [...document.querySelectorAll('.tile.picked')].map((t) => t.getAttribute('aria-label')) })`);
check('betting opens with a random tile picked: green "Bet … on random tile #n"', /^Bet \d+\.\d\d [A-Z]{3} on random tile #\d+$/.test(auto.text) && auto.cls.includes('mb-green') && auto.picked.length === 1 && /selected/.test(auto.picked[0]), `${auto.text} / ${auto.picked[0]}`);
await b.evaluate(`(() => { const t = [...document.querySelectorAll('.board .tile')].find((x) => !x.disabled && !x.classList.contains('picked')); t.click(); return true; })()`);
await sleep(200);
const yours = await b.evaluate(`${mainBtn}.textContent`);
check('tapping another tile switches to "Bet … on your tile #n"', /on your tile #\d+$/.test(yours), yours);
await b.evaluate(`${mainBtn}.click(), true`);
await b.waitFor(`/^Cancel bet/.test(${mainBtn}.textContent) && ${mainBtn}.className.includes('mb-red')`, 5_000, 'bet accepted');
const frame = await b.evaluate(`document.querySelector('.tile.mine')?.className`);
check('after betting: red "Cancel bet …", own tile framed bronze', /metal-bronze/.test(frame ?? ''), frame);
await b.waitFor(`/tiles going|finishing|Round started/i.test(document.querySelector('.mstatus')?.textContent || '')`, 15_000, 'running');
await b.waitFor(`(() => { const x = ${mainBtn}; if (/^Cash out .* now$/.test(x.textContent) && !x.disabled) { window.__cashText = x.textContent; window.__cashCls = x.className; x.click(); return true; } return /Place bet on random tile/.test(x.textContent); })()`, 15_000, 'cashout or loss');
await sleep(800);
const cash = await b.evaluate(`({ text: window.__cashText ?? null, cls: window.__cashCls ?? null, after: ${mainBtn}.textContent, you: document.querySelector('.plist li.you')?.textContent })`);
const outcome = cash.you ?? '';
log(`outcome: ${JSON.stringify(cash)}`);
if (cash.text) check('running: yellow "Cash out … now"', /mb-yellow/.test(cash.cls), cash.text);
check('no active bet while running: green "Place bet on random tile for next round"', /Place bet on random tile for next round/.test(cash.after), cash.after);
const feed = await b.evaluate(`[...document.querySelectorAll('.plist li .nick')].map((n) => n.textContent)`);
const masked = feed.every((n) => /^(You \()?[A-Za-z][A-Za-z]\*\*\*\w\)?$/.test(n));
check('players list shows only masked names', feed.length > 1 && masked, feed.slice(0, 4).join(', '));
check('own row first in the players list, marked "You"', /^You \(/.test(feed[0] ?? ''), feed[0]);
const tiles = await b.evaluate(`({ bands: [...new Set([...document.querySelectorAll('.board .tile')].map((t) => [...t.classList].find((c) => c.startsWith('band-'))))], gone: [...new Set([...document.querySelectorAll('.board .tile.band-gone .tile-count')].map((x) => x.textContent))] })`);
check('tiles carry traffic-light bands; gone tiles show only ×', tiles.bands.every((x) => /^band-(green|yellow|full|gone)$/.test(x)) && tiles.gone.join('') === '×', `${tiles.bands.join(',')} / ${tiles.gone.join('')}`);
await b.waitFor(`/Round over/.test(document.querySelector('.mstatus')?.textContent || '')`, 300_000, 'round end');
const end = await b.evaluate(`({ message: document.querySelector('.mstatus')?.textContent, covered: !!document.querySelector('.board .overlay'), history: [...(document.querySelector('.rounds tbody tr')?.children ?? [])].map((td) => td.textContent), heads: [...document.querySelectorAll('.rounds th')].map((th) => th.textContent) })`);
log(`round over: ${JSON.stringify(end)}`);
check('round played to the end; result in the status line, board not covered', /Round over/.test(end.message ?? '') && !end.covered && !!end.history, end.message);
check(
  'Recent rounds: Round id | Round max | Top man | Top cashout',
  end.heads.join('|') === 'Round id|Round max|Top man|Top cashout' &&
    /^#\d+$/.test(end.history[0]) &&
    end.history[1] === '10,000x' &&
    /^(\d[\d,.]*x n\d+|–)$/.test(end.history[2]) &&
    /^(\d[\d,.]*x \D?[\d,.]+|–)$/.test(end.history[3]),
  end.history.join(' | '),
);
// The round id opens that round's details, already verified.
await b.evaluate(`document.querySelector('.rounds tbody td button').click(), true`);
await b.waitFor(`!!document.querySelector('.verdict')`, 10_000, 'round details');
const details = await b.evaluate(`({ verdict: document.querySelector('.verdict').textContent, seed: [...document.querySelectorAll('.modal .kv code')].map((c) => c.textContent).find((t) => /^[0-9a-f]{64}$/.test(t)) })`);
check('clicking a round id opens its details with a passing verification', details.verdict.includes('Verified') && !!details.seed, details.verdict);
await b.evaluate(`document.querySelector('.modal-head button').click(), true`);
await sleep(200);

await b.evaluate(`document.querySelector('[aria-label="Provably fair: verify rounds"]').click(), true`);
await b.waitFor(`!!document.querySelector('.verify-row select')`, 5_000, 'fairness modal');
await b.evaluate(`(() => { const s = document.querySelector('.verify-row select'); const v = [...s.options].map((o) => o.value).find((x) => x.endsWith('#${roundId}')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, v); s.dispatchEvent(new Event('change', { bubbles: true })); return v; })()`);
await sleep(200);
await b.evaluate(`document.querySelector('.verify-row button').click(), true`);
await b.waitFor(`!!document.querySelector('.verdict')`, 10_000, 'verdict');
const verdict = await b.evaluate(`({ title: document.querySelector('#fair-title').textContent, verdict: document.querySelector('.verdict').textContent, checks: [...document.querySelectorAll('.checks li')].map((l) => l.textContent) })`);
check('fairness verifier passes (Web Crypto) for the round played', verdict.verdict.includes('Verified') && verdict.checks.every((c) => c.startsWith('✔')), verdict.verdict);
check('fairness modal titled with the game title', verdict.title.startsWith('Platforman'), verdict.title);
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
