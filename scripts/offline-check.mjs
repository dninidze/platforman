// Opens dist/platforman.html from disk in headless Chrome/Edge with networking disabled
// (DevTools offline emulation + an unreachable proxy + DNS mapped to nowhere) and checks, through the UI:
//   - <title> and header read "Platforman"; stage tabs read 10x / 100x / 10kx; Montserrat embedded (CHANGES_6)
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
const playerName = () => b.evaluate(`window.__p3session()?.displayName ?? null`);
const menuItem = async (label) => {
  await b.evaluate(`document.querySelector('.settings-btn').click(), true`);
  await b.waitFor(`[...document.querySelectorAll('.menu-item')].some((x) => x.textContent === '${label}')`, 5_000, 'menu');
  await b.evaluate(`[...document.querySelectorAll('.menu-item')].find((x) => x.textContent === '${label}').click(), true`);
};
const open = async (u) => {
  await b.cdp('Page.navigate', { url: u });
  await sleep(300);
  await b.waitFor(`!!document.querySelector('.board .tile') && !!window.__p3session?.()`, 20_000, 'room view');
};

// ---- load, identity, title, labels
await open(url);
const env = await b.evaluate(`({ online: navigator.onLine, secure: isSecureContext, webCrypto: !!crypto.subtle, title: document.title, header: document.querySelector('.brand')?.textContent.replace(/^[^A-Za-z]+/, '').trim(), prompt: !!document.querySelector('input#nick, .join-card input'), engine: window.__p3engine(), session: window.__p3session(), stages: [...document.querySelectorAll('.stage-pill')].map((p) => p.textContent), font: getComputedStyle(document.body).fontFamily, fontOk: document.fonts.check('600 16px Montserrat') && [...document.fonts].some((x) => x.family.replace(/"/g, '') === 'Montserrat' && x.status === 'loaded'), rooms: [...document.querySelectorAll('.panel h2')].some((h) => /rooms/i.test(h.textContent)), headerItems: [...document.querySelector('.header').children].map((c) => c.className), headerH: document.querySelector('.header').getBoundingClientRect().height })`);
log(`loaded: ${JSON.stringify({ ...env, session: { ...env.session, playerId: env.session.playerId.slice(0, 12) + '…' } })}`);
check('networking disabled (navigator.onLine is false)', env.online === false);
check('title and header are "Platforman"', env.title === 'Platforman' && env.header === 'Platforman', `${env.title} / ${env.header}`);
check('stage tabs read 10x / 100x / 10kx', env.stages.join(',') === '10x,100x,10kx', env.stages.join(','));
check('Montserrat is the page font and is loaded from the file', /^Montserrat/.test(env.font) && env.fontOk, env.font);
check('no Rooms panel', !env.rooms);
check('header: only brand, balance and settings; minimal height', env.headerItems.join(',') === 'brand,hbalance,settings' && env.headerH <= 48, `${env.headerItems.join(',')} / ${env.headerH}px`);
check('no name prompt: opens straight into the room', !env.prompt);
const name1 = await playerName();
check('generated demo name shown in the header', NAME_RE.test(name1 ?? '') && env.session.provider === 'demo', name1);
check('engine runs in the Web Worker', env.engine === 'web worker', env.engine);

await open(url);
const name2 = await playerName();
check('reload keeps the same name and id', name2 === name1 && (await b.evaluate('window.__p3session().playerId')) === env.session.playerId, name2);

// ---- full round (CHANGES_4 §2 main-button flow)
const mainBtn = `document.querySelector('.mainbtn')`;
const line1 = `(document.querySelector('.msgbox .msg-line:nth-child(1)')?.textContent || '')`;
const line2 = `(document.querySelector('.msgbox .msg-line:nth-child(2)')?.textContent || '')`;
await b.waitFor(`(() => { const m = ${line2}.match(/Betting closes in ([\\d.]+) s/); return m && Number(m[1]) > 4; })()`, 240_000, 'betting phase');
const roundId = await b.evaluate(`window.__p3round().split('#')[1]`);
const zero = await b.evaluate(`document.querySelector('.mbox .mult').textContent`);
check('multiplier reads 0.00x before the first tile', zero === '0.00x', zero);
log(`betting open for round #${roundId}`);
const auto = await b.evaluate(`({ text: ${mainBtn}.textContent, cls: ${mainBtn}.className, line1: ${line1}, frame: getComputedStyle(document.querySelector('.msgbox')).borderTopStyle, picked: [...document.querySelectorAll('.tile.picked')].map((t) => t.getAttribute('aria-label')) })`);
check('betting opens with a random tile picked: green "Bet 1.00 EUR", hint on message line 1', /^Bet \d+\.\d\d [A-Z]{3}$/.test(auto.text) && auto.cls.includes('mb-green') && auto.picked.length === 1 && /selected/.test(auto.picked[0]) && /random tile #\d+/i.test(auto.line1), `${auto.text} / ${auto.line1} / ${auto.picked[0]}`);
check('message box has a frame and two lines', auto.frame === 'solid' && (await b.evaluate(`document.querySelectorAll('.msgbox .msg-line').length`)) === 2);
const amountBox = await b.evaluate(`({ group: [...(document.querySelector('.amount-group')?.children ?? [])].map((c) => c.tagName + ':' + (c.tagName === 'INPUT' ? c.value : c.textContent).trim()), weight: getComputedStyle(document.querySelector('.amount-group .amount')).fontWeight, cur: !!document.querySelector('.betbox .cur') })`);
check('amount box: − amount + joined, number only (semibold), no currency', amountBox.group.length === 3 && /^BUTTON:−$/.test(amountBox.group[0]) && /^INPUT:\d+\.\d\d$/.test(amountBox.group[1]) && /^BUTTON:\+$/.test(amountBox.group[2]) && amountBox.weight === '600' && !amountBox.cur, `${amountBox.group.join(' ')} / ${amountBox.weight}`);
await b.evaluate(`(() => { const t = [...document.querySelectorAll('.board .tile')].find((x) => !x.disabled && !x.classList.contains('picked')); t.click(); return true; })()`);
await sleep(200);
const yours = await b.evaluate(line1);
check('tapping another tile: message line 1 "Tile #n selected"', /^Tile #\d+ selected$/.test(yours), yours);
await b.evaluate(`${mainBtn}.click(), true`);
await b.waitFor(`/^Cancel bet \\d+\\.\\d\\d [A-Z]{3}$/.test(${mainBtn}.textContent) && ${mainBtn}.className.includes('mb-red')`, 5_000, 'bet accepted');
const frame = await b.evaluate(`({ cls: document.querySelector('.tile.mine')?.className, badge: document.querySelector('.tile.mine .you-badge')?.textContent })`);
check('after betting: red "Cancel bet …", own tile framed bronze and labelled ME', /metal-bronze/.test(frame.cls ?? '') && frame.badge === 'ME', `${frame.cls} / ${frame.badge}`);
await b.waitFor(`/^Tiles left/.test(${line2})`, 15_000, 'running');
await b.waitFor(`(() => { const x = ${mainBtn}; if (/^Cash out \\d/.test(x.textContent) && !x.disabled) { window.__cashText = x.textContent; window.__cashCls = x.className; x.click(); return true; } return /^Bet /.test(x.textContent); })()`, 15_000, 'cashout or loss');
await sleep(800);
const cash = await b.evaluate(`({ text: window.__cashText ?? null, cls: window.__cashCls ?? null, after: ${mainBtn}.textContent, line1: ${line1}, me: [...(document.querySelector('.lbtable tr.me')?.children ?? [])].map((td) => td.textContent) })`);
const outcome = cash.me.join(' | ');
log(`outcome: ${JSON.stringify(cash)}`);
if (cash.text) check('running: yellow "Cash out 1.01 EUR"', /mb-yellow/.test(cash.cls) && /^Cash out \d+\.\d\d [A-Z]{3}$/.test(cash.text), cash.text);
check('no active bet while running: green "Bet 1.00 EUR" (queues for next round)', /^Bet \d+\.\d\d [A-Z]{3}$/.test(cash.after), cash.after);
const lb = await b.evaluate(`({ heads: [...document.querySelectorAll('.lbtable th')].map((t) => t.textContent), nicks: [...document.querySelectorAll('.lbtable td.nick')].map((n) => n.textContent), labels: [...document.querySelectorAll('.lb-label')].map((x) => x.textContent), big: [...document.querySelectorAll('.lb-big')].map((x) => x.textContent), stats: !!document.querySelector('.kv.stats') })`);
check('live bets: header active/total bets + total cashout; columns Player|Bet|Tiles|x|Win; no stats block', lb.heads.join('|') === 'Player|Bet|Tiles|x|Win' && /^[\d,]+ \/ [\d,]+$/.test(lb.big[0]) && lb.labels[1] === 'Total cashout' && !lb.stats, `${lb.big.join(' · ')} / ${lb.heads.join('|')}`);
const masked = lb.nicks.slice(1).every((n) => /^[A-Za-z][A-Za-z]\*\*\*\w$/.test(n));
check('live bets show only masked names', lb.nicks.length > 1 && masked, lb.nicks.slice(0, 4).join(', '));
check('own row first, labelled "Me"', lb.nicks[0] === 'Me' && cash.me.length === 5, outcome);
if (cash.text) check('own row after cashing out: tiles survived in green, x and Win filled', /^\d+$/.test(cash.me[2]) && /x$/.test(cash.me[3]) && cash.me[4] !== '' && (await b.evaluate(`document.querySelector('.lbtable tr.me td:nth-child(3)').className`)) === 'win', outcome);
const tiles = await b.evaluate(`({ bands: [...new Set([...document.querySelectorAll('.board .tile')].map((t) => [...t.classList].find((c) => c.startsWith('band-'))))], gone: [...new Set([...document.querySelectorAll('.board .tile.band-gone .tile-count')].map((x) => x.textContent))] })`);
check('tiles carry traffic-light bands; gone tiles show only ×', tiles.bands.every((x) => /^band-(green|yellow|full|gone)$/.test(x)) && tiles.gone.join('') === '×', `${tiles.bands.join(',')} / ${tiles.gone.join('')}`);
await b.waitFor(`/Next round in/.test(${line2})`, 300_000, 'round end');
const end = await b.evaluate(`({ message: ${line1}, line2: ${line2}, covered: !!document.querySelector('.loading'), left: document.querySelectorAll('.board .tile:not(.band-gone)').length, winner: [...document.querySelectorAll('.board .tile.winner')].map((t) => t.getAttribute('aria-label')), max: document.querySelector('.rp-max')?.textContent, tabs: [...document.querySelectorAll('.rp-tab')].map((t) => t.textContent), history: [...(document.querySelector('.rounds tbody tr')?.children ?? [])].map((td) => [...td.childNodes].map((n) => n.textContent).join(' / ')), heads: [...document.querySelectorAll('.rounds th')].map((th) => th.textContent.trim()) })`);
log(`round over: ${JSON.stringify(end)}`);
check('round played to its end; message on line 1, countdown on line 2, board not covered yet', (end.message ?? '').length > 0 && /^Next round in/.test(end.line2) && !end.covered && [1, 9, 10].includes(end.left), `${end.message} / ${end.line2} / tiles standing ${end.left}`);
check('the tiles that survived the last stage played have the gold frame', end.winner.length === end.left && end.winner.every((w) => /survived the stage/.test(w)), `${end.winner.length} framed`);
await b.waitFor(`!!document.querySelector('.loading')`, 4_000, 'loading screen');
const loadStart = Date.now();
await b.waitFor(`!document.querySelector('.loading') && /Betting closes/.test(${line2})`, 8_000, 'betting after loading');
const loadMs = Date.now() - loadStart;
check('5 s loading screen between rounds, then betting', loadMs > 4_000 && loadMs < 6_500, `${loadMs} ms`);
check(
  'Recent / Top: tabs, "Round max 10,778x" in the header, Round | Top man | Top cashout two-line cells',
  end.tabs.join('|') === 'Recent|24h|Week|Month|Year' &&
    end.max === 'Round max 10,778x' &&
    end.heads.join('|') === 'Round|Top man|Top cashout' &&
    /^#\d+ \/ Reached (10x|100x|10kx)$/.test(end.history[0]) &&
    /^(\d[\d,.]*x \/ \d+ tiles|–)$/.test(end.history[1]) &&
    /^(\d[\d,.]*x \/ \D?[\d,.]+|–)$/.test(end.history[2]),
  end.history.join(' | '),
);
// The round id opens that round's details, already verified.
await b.evaluate(`document.querySelector('.rounds tbody td button').click(), true`);
await b.waitFor(`!!document.querySelector('.verdict')`, 10_000, 'round details');
const details = await b.evaluate(`({ verdict: document.querySelector('.verdict').textContent, seed: [...document.querySelectorAll('.modal .kv code')].map((c) => c.textContent).find((t) => /^[0-9a-f]{64}$/.test(t)) })`);
check('clicking a round id opens its details with a passing verification', details.verdict.includes('Verified') && !!details.seed, details.verdict);
await b.evaluate(`document.querySelector('.modal-head button').click(), true`);
await sleep(200);

await menuItem('Provably fair');
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
await menuItem('Dev panel');
await b.waitFor(`[...document.querySelectorAll('.dev-panel button')].some((x) => x.textContent === 'New demo identity')`, 5_000, 'dev panel');
await b.evaluate(`[...document.querySelectorAll('.dev-panel button')].find((x) => x.textContent === 'New demo identity').click(), true`);
await sleep(500);
await b.waitFor(`!!document.querySelector('.board .tile') && !!window.__p3session?.()`, 20_000, 'room after new identity');
const name3 = await playerName();
check('"New demo identity" regenerates the name', NAME_RE.test(name3 ?? '') && name3 !== name1, `${name1} → ${name3}`);

// ---- aggregator launch
await open(`${url}?token=abc&currency=USD`);
const agg = await b.evaluate(`({ session: window.__p3session(), balance: document.querySelector('.hbalance')?.textContent })`);
check('?token=abc&currency=USD goes through the aggregator provider and shows USD', agg.session.provider === 'aggregator' && agg.session.currency === 'USD' && agg.balance.startsWith('$'), `${agg.session.provider}, ${agg.session.currency}, ${agg.balance}, ${agg.session.displayName}`);

const external = b.external();
// ---- Top results survive a reload (localStorage, CHANGES_6 §10)
await open(url);
await b.evaluate(`[...document.querySelectorAll('.rp-tab')].find((t) => t.textContent === '24h').click(), true`);
await sleep(300);
const topView = await b.evaluate(`({ heads: [...document.querySelectorAll('.rounds th')].map((th) => th.textContent), sorts: [...document.querySelectorAll('.sortbtn')].map((x) => x.textContent + (x.classList.contains('on') ? '*' : '')), rows: [...document.querySelectorAll('.rounds tbody tr')].map((tr) => tr.textContent) })`);
check('Top 24h keeps the rounds after a reload; default sort Top man x; x | Win switch on Top cashout', topView.rows.length >= 1 && !/No rounds/.test(topView.rows[0]) && topView.sorts.join(',') === 'x*,x,Win', `${topView.rows.length} rows / ${topView.sorts.join(',')}`);

check('no network requests', external.length === 0, external.join(' '));
check('no console errors', b.consoleErrors.length === 0, b.consoleErrors.slice(0, 3).join(' | '));
const report = { url, browser: browserPath, env: { ...env, session: undefined }, roundId, outcome, end, verdict, checks, requests: b.requests.length, externalRequests: external, consoleErrors: b.consoleErrors, seconds: (Date.now() - t0) / 1000 };
writeFileSync(resolve(appRoot, 'data/offline-check.json'), JSON.stringify(report, null, 2));
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `FAIL: ${failed.map((c) => c.name).join('; ')}` : `PASS: all ${checks.length} checks, full round played from disk with networking disabled`);
b.close();
process.exit(failed.length ? 1 : 0);
