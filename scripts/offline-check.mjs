// Opens dist/platform3.html from disk in headless Chrome/Edge with networking disabled
// (DevTools offline emulation + an unreachable proxy + DNS mapped to nowhere), plays one full round
// through the UI (join, pick a tile, bet, cash out after the first removal if still standing), waits for
// the round to end, runs the Fairness verifier, and reports every network request the page attempted.
//
//   node scripts/offline-check.mjs [path-to-browser]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const file = resolve(appRoot, 'dist/platform3.html');
if (!existsSync(file)) throw new Error('run `npm run build` first');
const candidates = [
  process.argv[2],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const browserPath = candidates.find((p) => existsSync(p));
if (!browserPath) throw new Error('no Chrome/Edge found; pass its path as an argument');

const port = 9333 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'p3-offline-'));
const browser = spawn(browserPath, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--proxy-server=http://127.0.0.1:9',
  '--host-resolver-rules=MAP * ~NOTFOUND',
  'about:blank',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
  } catch {
    /* not up yet */
  }
}
if (!target) throw new Error('browser did not expose DevTools');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const waiters = new Map();
const requests = [];
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiters.has(m.id)) {
    waiters.get(m.id)(m);
    waiters.delete(m.id);
  } else if (m.method === 'Network.requestWillBeSent') {
    requests.push(m.params.request.url.slice(0, 80));
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails.text);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
const cdp = (method, params = {}) =>
  new Promise((resolveCall) => {
    const n = ++id;
    waiters.set(n, resolveCall);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const waitFor = async (expr, timeoutMs, what) => {
  const t0 = Date.now();
  for (;;) {
    if (await evaluate(expr)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(200);
  }
};

await cdp('Network.enable');
await cdp('Runtime.enable');
await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
const url = pathToFileURL(file).href;
await cdp('Page.navigate', { url });
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

await waitFor(`!!document.querySelector('#nick') && !document.querySelector('.join-card button').textContent.includes('Connecting')`, 15_000, 'engine start');
const env = await evaluate(`({ href: location.href.slice(0, 60), online: navigator.onLine, secure: isSecureContext, webCrypto: !!crypto.subtle })`);
log(`page loaded: ${JSON.stringify(env)}`);
await evaluate(`(() => {
  const input = document.querySelector('#nick');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'offline_check');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(100);
await evaluate(`document.querySelector('.join-card button').click(), true`);
await waitFor(`!!document.querySelector('.board .tile')`, 10_000, 'board');
const engine = await evaluate('window.__p3engine()');
log(`joined; engine runs in: ${engine}`);
// Wait for a fresh betting phase with at least 4 s left.
await waitFor(`(() => { const l = document.querySelector('.phase-label')?.textContent || ''; const m = l.match(/Betting closes in ([\\d.]+)s/); return m && Number(m[1]) > 4; })()`, 240_000, 'betting phase');
const roundId = await evaluate(`document.querySelectorAll('.stat-value')[2].textContent`);
log(`betting open for round #${roundId}`);
await evaluate(`(() => { const t = [...document.querySelectorAll('.board .tile')].find((b) => !b.disabled && /: \\d+ players/.test(b.getAttribute('aria-label')) && !b.classList.contains('full')); t.click(); return true; })()`);
await sleep(200);
await evaluate(`[...document.querySelectorAll('.betpanel button')].find((b) => b.textContent.startsWith('Bet '))?.click(), true`);
await waitFor(`/Cancel bet/.test(document.querySelector('.betpanel')?.textContent || '')`, 5_000, 'bet accepted');
const balanceAfterBet = await evaluate(`document.querySelector('.stat-value').textContent`);
log(`bet placed, balance ${balanceAfterBet}`);
await waitFor(`/Tiles going|finishing fast/.test(document.querySelector('.phase-label')?.textContent || '')`, 15_000, 'running');
log('round running');
// Cash out as soon as the first removal opens cashout (if our tile is still standing).
await waitFor(`(() => { const b = [...document.querySelectorAll('.betpanel button')].find((x) => x.textContent.startsWith('Cash out €')); if (b && !b.disabled) { b.click(); return true; } return /went Gone|Cashed out/.test(document.querySelector('.betpanel')?.textContent || ''); })()`, 15_000, 'cashout or loss');
await sleep(500);
const outcome = await evaluate(`document.querySelector('.betpanel')?.textContent`);
log(`outcome: ${outcome}`);
await waitFor(`/Next round in/.test(document.querySelector('.phase-label')?.textContent || '')`, 300_000, 'round end');
const end = await evaluate(`({ overlay: document.querySelector('.overlay.ended')?.textContent, balance: document.querySelector('.stat-value').textContent, history: document.querySelector('.history li')?.textContent })`);
log(`round over: ${JSON.stringify(end)}`);

// Fairness verifier on the round just played.
await evaluate(`document.querySelector('[aria-label="Provably fair: verify rounds"]').click(), true`);
await waitFor(`!!document.querySelector('.verify-row select')`, 5_000, 'fairness modal');
await evaluate(`(() => { const s = document.querySelector('.verify-row select'); const v = [...s.options].map((o) => o.value).find((x) => x.endsWith('#${roundId}')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, v); s.dispatchEvent(new Event('change', { bubbles: true })); return v; })()`);
await sleep(200);
await evaluate(`[...document.querySelectorAll('.verify-row button')][0].click(), true`);
await waitFor(`!!document.querySelector('.verdict')`, 10_000, 'verdict');
const verdict = await evaluate(`({ verdict: document.querySelector('.verdict').textContent, checks: [...document.querySelectorAll('.checks li')].map((l) => l.textContent), source: document.querySelector('.modal .kv:last-of-type span:nth-child(2)')?.textContent })`);
log(`verifier: ${JSON.stringify(verdict)}`);

const external = requests.filter((u) => !/^(file|data|blob):/.test(u));
const report = { url, browser: browserPath, env, engine, roundId, outcome, end, verdict, requests: requests.length, externalRequests: external, consoleErrors, seconds: (Date.now() - t0) / 1000 };
writeFileSync(resolve(appRoot, 'data/offline-check.json'), JSON.stringify(report, null, 2));
const ok = engine === 'web worker' && verdict.verdict.includes('Verified') && external.length === 0 && consoleErrors.length === 0;
console.log(ok ? 'PASS: full round played from disk with networking disabled' : `FAIL: ${JSON.stringify({ engine, external, consoleErrors })}`);
ws.close();
browser.kill();
process.exit(ok ? 0 : 1);
