// Minimal headless Chrome/Edge driver over the DevTools protocol (Node 22+ built-in WebSocket).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser(explicit) {
  const candidates = [
    explicit,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('no Chrome/Edge found; pass its path as an argument');
  return found;
}

/** Launch with networking blocked (unreachable proxy, DNS to nowhere) and return a CDP session. */
export async function launch(browserPath, { headed = false } = {}) {
  const port = 9333 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'p3-browser-'));
  const proc = spawn(browserPath, [
    ...(headed ? [] : ['--headless=new']),
    '--window-size=1280,900',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--proxy-server=http://127.0.0.1:9',
    '--host-resolver-rules=MAP * ~NOTFOUND',
    'about:blank',
  ]);
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
    } else if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url.slice(0, 80));
    else if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const cdp = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      waiters.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  const waitFor = async (expression, timeoutMs, what) => {
    const t0 = Date.now();
    for (;;) {
      if (await evaluate(expression)) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await sleep(200);
    }
  };
  await cdp('Network.enable');
  await cdp('Runtime.enable');
  await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  return {
    cdp,
    evaluate,
    waitFor,
    requests,
    consoleErrors,
    external: () => requests.filter((u) => !/^(file|data|blob):/.test(u)),
    close: () => {
      ws.close();
      proc.kill();
    },
  };
}

/** Set a React-controlled input's value. */
export const setInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;
