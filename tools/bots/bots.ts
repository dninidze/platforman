/**
 * WebSocket load test: up to 9,900 bots in one room that bet, hop tiles and cash out at random targets.
 *
 *   npm run bots -- --players 9900 [--rounds 20] [--workers 8] [--ramp 600]
 *                   [--url ws://host:port/ws]   (default: spawn a local server with ROOM_SOFT_CAP=players)
 *                   [--betting-ms 10000] [--tick-ms 500] [--json out.json]
 *
 * Reports p50/p95/p99 action latency (send -> result), server CPU and memory (from /metrics),
 * broadcast bytes per second per client and rejected-action counts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { WebSocket } from 'ws';
import { STAGE_REMOVALS, decodeGoneMask, type ServerMessage, type Stage } from '@p3/shared';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface WorkerStats {
  latencies: Record<string, number[]>;
  rejects: Record<string, number>;
  bytesIn: number;
  msgsIn: number;
  errors: string[];
  connected: number;
  closedUnexpectedly: number;
  roundEnds: string[];
  bets: number;
  cashouts: number;
  moves: number;
  resyncs: number;
}

const emptyStats = (): WorkerStats => ({
  latencies: { bet: [], move: [], cashout: [] },
  rejects: {},
  bytesIn: 0,
  msgsIn: 0,
  errors: [],
  connected: 0,
  closedUnexpectedly: 0,
  roundEnds: [],
  bets: 0,
  cashouts: 0,
  moves: 0,
  resyncs: 0,
});

// ------------------------------------------------------------------------------------------- worker

interface Bot {
  i: number;
  ws: WebSocket;
  rid: number;
  pending: Map<number, { kind: string; at: number }>;
  roundId: string;
  phase: string;
  stage: Stage;
  removed: number;
  counts: number[];
  gone: boolean[];
  lastSeq: number;
  state: string;
  tile: number | null;
  target: { stage: Stage; k: number };
  betTimer: NodeJS.Timeout | null;
  betTries: number;
  cashoutSent: boolean;
  closing: boolean;
}

function runWorker() {
  const { url, from, to, rampPerSec, bettingMs, moveProb, reportEveryMs } = workerData as {
    url: string;
    from: number;
    to: number;
    rampPerSec: number;
    bettingMs: number;
    moveProb: number;
    reportEveryMs: number;
  };
  let stats = emptyStats();
  const bots: Bot[] = [];
  let stopping = false;
  const rnd = (n: number) => Math.floor(Math.random() * n);

  const pickTarget = (): { stage: Stage; k: number } => {
    const u = Math.random();
    const stage: Stage = u < 0.85 ? 1 : u < 0.97 ? 2 : 3;
    return { stage, k: 1 + rnd(STAGE_REMOVALS[stage - 1]) };
  };

  const send = (b: Bot, kind: string, msg: Record<string, unknown>) => {
    if (b.ws.readyState !== WebSocket.OPEN) return;
    const rid = ++b.rid;
    b.pending.set(rid, { kind, at: performance.now() });
    b.ws.send(JSON.stringify({ ...msg, rid }));
  };

  const freeTile = (b: Bot): number => {
    for (let tries = 0; tries < 30; tries++) {
      const t = rnd(100);
      if (!b.gone[t] && b.counts[t] < 99 && t !== b.tile) return t;
    }
    return rnd(100);
  };

  const placeBet = (b: Bot) => {
    b.betTimer = null;
    if (b.phase !== 'betting' || b.state === 'betting') return;
    b.target = pickTarget();
    send(b, 'bet', { t: 'bet', amount: 10 + rnd(990), tileId: freeTile(b) });
  };

  const onMessage = (b: Bot, raw: string) => {
    stats.bytesIn += raw.length;
    stats.msgsIn++;
    const m = JSON.parse(raw) as ServerMessage;
    if ('seq' in m && m.t !== 'roundState') {
      if (m.seq > b.lastSeq + 1 && b.lastSeq > 0) {
        stats.resyncs++;
        b.ws.send(JSON.stringify({ t: 'resync' }));
      }
      b.lastSeq = Math.max(b.lastSeq, m.seq);
    }
    switch (m.t) {
      case 'roundState': {
        b.lastSeq = m.seq;
        const newBetting = m.phase === 'betting' && (b.roundId !== m.roundId || b.phase !== 'betting');
        b.roundId = m.roundId;
        b.phase = m.phase;
        b.stage = m.stage;
        b.removed = m.removedCount;
        b.counts = m.tiles;
        b.gone = decodeGoneMask(m.goneMask);
        if (newBetting) {
          b.state = 'idle';
          b.tile = null;
          b.cashoutSent = false;
          b.betTries = 0;
          if (b.betTimer) clearTimeout(b.betTimer);
          // Spread bets over the first 60% of the betting window.
          b.betTimer = setTimeout(() => placeBet(b), Math.random() * bettingMs * 0.6);
        }
        return;
      }
      case 'tick': {
        b.phase = 'running';
        if (m.stage !== b.stage) b.gone = new Array(100).fill(false);
        b.stage = m.stage;
        b.removed = m.removedCount;
        b.gone[m.tileGone] = true;
        for (let i = 0; i < m.countsDelta.length; i += 2) b.counts[m.countsDelta[i]] = m.countsDelta[i + 1];
        if (b.state !== 'alive' || b.tile === m.tileGone) return;
        const reached = m.stage > b.target.stage || (m.stage === b.target.stage && m.removedCount >= b.target.k);
        if (reached && !b.cashoutSent) {
          b.cashoutSent = true;
          send(b, 'cashout', { t: 'cashout' });
        } else if (Math.random() < moveProb) {
          send(b, 'move', { t: 'move', tileId: freeTile(b) });
        }
        return;
      }
      case 'occupancy':
        for (let i = 0; i < m.countsDelta.length; i += 2) b.counts[m.countsDelta[i]] = m.countsDelta[i + 1];
        return;
      case 'stageEnd':
        b.phase = 'intermission';
        b.gone = new Array(100).fill(false);
        if (b.state === 'alive' && Math.random() < moveProb * 4) send(b, 'move', { t: 'move', tileId: freeTile(b) });
        return;
      case 'roundEnd':
        b.phase = 'ended';
        if (b.i === from) stats.roundEnds.push(m.roundId);
        return;
      case 'you':
        b.state = m.state;
        b.tile = m.tileId;
        return;
      case 'betResult':
      case 'moveResult':
      case 'cashoutResult':
      case 'cancelResult': {
        const p = m.rid !== undefined ? b.pending.get(m.rid) : undefined;
        if (p) {
          b.pending.delete(m.rid!);
          (stats.latencies[p.kind] ??= []).push(performance.now() - p.at);
        }
        if (m.t === 'betResult') stats.bets++;
        if (m.t === 'cashoutResult') stats.cashouts++;
        if (m.t === 'moveResult') {
          stats.moves++;
          if (m.ok && m.tileId !== undefined) b.tile = m.tileId;
        }
        if (!m.ok) {
          const key = `${m.t.replace('Result', '')}:${m.reason}`;
          stats.rejects[key] = (stats.rejects[key] ?? 0) + 1;
          if (m.t === 'betResult' && m.reason === 'TILE_FULL' && b.phase === 'betting' && ++b.betTries < 5) placeBet(b);
          if (m.t === 'cashoutResult') b.cashoutSent = m.reason !== 'PHASE' ? b.cashoutSent : false;
        }
        return;
      }
      case 'error':
        stats.rejects[`error:${m.code}`] = (stats.rejects[`error:${m.code}`] ?? 0) + 1;
        if (m.code !== 'RATE_LIMIT') stats.errors.push(`${m.code}: ${m.message}`);
        return;
    }
  };

  const open = (i: number) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    const b: Bot = {
      i,
      ws,
      rid: 0,
      pending: new Map(),
      roundId: '',
      phase: '',
      stage: 1,
      removed: 0,
      counts: new Array(100).fill(0),
      gone: new Array(100).fill(false),
      lastSeq: 0,
      state: 'idle',
      tile: null,
      target: pickTarget(),
      betTimer: null,
      betTries: 0,
      cashoutSent: false,
      closing: false,
    };
    bots.push(b);
    ws.on('open', () => {
      stats.connected++;
      ws.send(JSON.stringify({ t: 'join', nickname: `bot${i}` }));
    });
    ws.on('message', (d) => {
      try {
        onMessage(b, String(d));
      } catch (e) {
        stats.errors.push(`client parse: ${String(e)}`);
      }
    });
    ws.on('error', (e) => stats.errors.push(`ws error: ${e.message}`));
    ws.on('close', () => {
      if (!stopping) stats.closedUnexpectedly++;
    });
  };

  // Ramp up connections.
  let next = from;
  const batch = Math.max(1, Math.round(rampPerSec / 20));
  const ramp = setInterval(() => {
    for (let n = 0; n < batch && next < to; n++) open(next++);
    if (next >= to) clearInterval(ramp);
  }, 50);

  setInterval(() => {
    parentPort!.postMessage({ type: 'stats', stats });
    stats = { ...emptyStats(), connected: stats.connected };
  }, reportEveryMs);

  parentPort!.on('message', (msg: { type: string }) => {
    if (msg.type === 'stop') {
      stopping = true;
      for (const b of bots) {
        if (b.betTimer) clearTimeout(b.betTimer);
        b.ws.close();
      }
      parentPort!.postMessage({ type: 'stats', stats });
      setTimeout(() => process.exit(0), 300);
    }
  });
}

// ------------------------------------------------------------------------------------------- main

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function startServer(port: number, env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/main.ts'], {
    cwd: APP_ROOT,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr!.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start')), 30_000);
    child.stdout!.on('data', (d) => {
      if (String(d).includes('[p3] server on')) {
        clearTimeout(t);
        res();
      }
    });
    child.once('exit', (code) => rej(new Error(`server exited ${code}`)));
  });
  return child;
}

interface MetricsSample {
  at: number;
  cpu: { user: number; system: number };
  mem: { rss: number; heapUsed: number };
  bytesOut: number;
  msgsOut: number;
  broadcastsDropped: number;
  sockets: number;
}

async function main() {
  const players = Number(arg('players', '9900'));
  const rounds = Number(arg('rounds', '20'));
  const workersN = Math.max(1, Math.min(Number(arg('workers', String(Math.min(8, availableParallelism() - 2)))), players));
  const rampPerSec = Number(arg('ramp', '600'));
  const bettingMs = Number(arg('betting-ms', '10000'));
  const tickMs = arg('tick-ms', '');
  const moveProb = Number(arg('move-prob', '0.03'));
  const port = Number(arg('port', '8181'));
  let url = arg('url', '');
  let server: ChildProcess | null = null;
  const t0 = Date.now();

  if (!url) {
    const dataDir = resolve(APP_ROOT, 'data/loadtest');
    mkdirSync(dataDir, { recursive: true });
    server = await startServer(port, {
      ROOM_SOFT_CAP: String(Math.max(players, 1)),
      BETTING_MS: String(bettingMs),
      DATA_DIR: dataDir,
      ...(tickMs ? { TICK_MS: tickMs } : {}),
    });
    url = `ws://127.0.0.1:${port}/ws`;
  }
  const httpBase = url.replace(/^ws/, 'http').replace(/\/ws$/, '');
  console.log(`load test: ${players} bots, ${workersN} workers, ${rounds} rounds, ramp ${rampPerSec}/s -> ${url}`);

  const chunk = Math.ceil(players / workersN);
  const totals = emptyStats();
  const connectedBy = new Map<number, number>();
  let measuring = false;
  const workers = Array.from({ length: workersN }, (_, w) => {
    const worker = new Worker(fileURLToPath(import.meta.url), {
      execArgv: ['--import', 'tsx'],
      workerData: { url, from: w * chunk, to: Math.min(players, (w + 1) * chunk), rampPerSec: rampPerSec / workersN, bettingMs, moveProb, reportEveryMs: 1000 },
    });
    worker.on('message', (msg: { type: string; stats: WorkerStats }) => {
      const s = msg.stats;
      connectedBy.set(w, s.connected);
      totals.roundEnds.push(...s.roundEnds);
      totals.errors.push(...s.errors);
      totals.closedUnexpectedly += s.closedUnexpectedly;
      if (!measuring) return;
      for (const [k, v] of Object.entries(s.latencies)) (totals.latencies[k] ??= []).push(...v);
      for (const [k, v] of Object.entries(s.rejects)) totals.rejects[k] = (totals.rejects[k] ?? 0) + v;
      totals.bytesIn += s.bytesIn;
      totals.msgsIn += s.msgsIn;
      totals.bets += s.bets;
      totals.cashouts += s.cashouts;
      totals.moves += s.moves;
      totals.resyncs += s.resyncs;
    });
    worker.on('error', (e) => totals.errors.push(`worker: ${e.message}`));
    return worker;
  });

  const metrics: MetricsSample[] = [];
  const poll = setInterval(async () => {
    try {
      const m = (await (await fetch(`${httpBase}/metrics`)).json()) as Omit<MetricsSample, 'at'>;
      metrics.push({ ...m, at: Date.now() });
    } catch {
      /* server busy */
    }
  }, 1000);

  // Wait for all bots to connect, then measure the next `rounds` full rounds.
  const connected = () => [...connectedBy.values()].reduce((a, b) => a + b, 0);
  while (connected() < players) {
    await new Promise((r) => setTimeout(r, 500));
    if (Date.now() - t0 > 180_000) throw new Error(`only ${connected()} of ${players} bots connected`);
  }
  const rampSecs = (Date.now() - t0) / 1000;
  const skip = new Set(totals.roundEnds);
  // The round in progress at the end of the ramp is partial: count from the next one.
  while (totals.roundEnds.filter((r) => !skip.has(r)).length < 1) await new Promise((r) => setTimeout(r, 200));
  console.log(`all ${players} bots connected in ${rampSecs.toFixed(1)} s; measuring ${rounds} rounds...`);
  for (const r of totals.roundEnds) skip.add(r);
  measuring = true;
  const mStart = Date.now();
  const firstMetric = metrics.length;
  let lastLog = 0;
  for (;;) {
    const done = totals.roundEnds.filter((r) => !skip.has(r)).length;
    if (done >= rounds) break;
    if (done !== lastLog) {
      lastLog = done;
      console.log(`  round ${done}/${rounds} done (${((Date.now() - mStart) / 1000).toFixed(0)} s)`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const mSecs = (Date.now() - mStart) / 1000;
  measuring = false;
  clearInterval(poll);
  for (const w of workers) w.postMessage({ type: 'stop' });
  await new Promise((r) => setTimeout(r, 1500));
  const finalMetrics = metrics.slice(firstMetric);

  // ---- report
  const lat: Record<string, { n: number; p50: number; p95: number; p99: number; max: number }> = {};
  const all: number[] = [];
  for (const [k, v] of Object.entries(totals.latencies)) {
    const s = [...v].sort((a, b) => a - b);
    all.push(...v);
    lat[k] = { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s.at(-1) ?? NaN };
  }
  all.sort((a, b) => a - b);
  lat.all = { n: all.length, p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), max: all.at(-1) ?? NaN };

  const cpuPct: number[] = [];
  for (let i = 1; i < finalMetrics.length; i++) {
    const a = finalMetrics[i - 1];
    const b = finalMetrics[i];
    const cpuMs = (b.cpu.user + b.cpu.system - a.cpu.user - a.cpu.system) / 1000;
    cpuPct.push((100 * cpuMs) / (b.at - a.at));
  }
  const first = finalMetrics[0];
  const last = finalMetrics.at(-1)!;
  const avg = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / Math.max(1, xs.length);
  const span = (last.at - first.at) / 1000;
  const report = {
    players,
    rounds,
    workers: workersN,
    rampSeconds: rampSecs,
    measuredSeconds: mSecs,
    latencyMs: lat,
    serverCpuPercent: { avg: avg(cpuPct), max: Math.max(...cpuPct), samples: cpuPct.length },
    serverMemMB: { rssMax: Math.max(...finalMetrics.map((m) => m.mem.rss)) / 2 ** 20, heapUsedMax: Math.max(...finalMetrics.map((m) => m.mem.heapUsed)) / 2 ** 20 },
    serverOut: {
      bytesPerSec: (last.bytesOut - first.bytesOut) / span,
      msgsPerSec: (last.msgsOut - first.msgsOut) / span,
      broadcastsDropped: last.broadcastsDropped - first.broadcastsDropped,
    },
    perClient: { bytesPerSec: totals.bytesIn / mSecs / players, msgsPerSec: totals.msgsIn / mSecs / players },
    actions: { bets: totals.bets, moves: totals.moves, cashouts: totals.cashouts },
    rejected: totals.rejects,
    clientResyncs: totals.resyncs,
    unexpectedCloses: totals.closedUnexpectedly,
    errors: totals.errors.slice(0, 20),
    errorCount: totals.errors.length,
  };

  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
  console.log('\n=== Platform 3 load test ===');
  console.log(`${players} bots, ${rounds} rounds measured over ${mSecs.toFixed(0)} s (ramp ${rampSecs.toFixed(1)} s)`);
  console.log('action latency ms (send -> result):');
  for (const [k, v] of Object.entries(lat)) console.log(`  ${k.padEnd(8)} n=${String(v.n).padStart(8)}  p50 ${f(v.p50)}  p95 ${f(v.p95)}  p99 ${f(v.p99)}  max ${f(v.max)}`);
  console.log(`server CPU: avg ${f(report.serverCpuPercent.avg)}%  max ${f(report.serverCpuPercent.max)}% (of one core)`);
  console.log(`server memory: rss max ${f(report.serverMemMB.rssMax)} MB, heap used max ${f(report.serverMemMB.heapUsedMax)} MB`);
  console.log(`server out: ${(report.serverOut.bytesPerSec / 2 ** 20).toFixed(2)} MB/s, ${f(report.serverOut.msgsPerSec)} msgs/s, dropped broadcasts ${report.serverOut.broadcastsDropped}`);
  console.log(`per client: ${f(report.perClient.bytesPerSec)} B/s, ${report.perClient.msgsPerSec.toFixed(2)} msgs/s`);
  console.log(`actions: ${totals.bets} bets, ${totals.moves} moves, ${totals.cashouts} cashouts`);
  console.log(`rejected: ${JSON.stringify(totals.rejects)}`);
  console.log(`client resyncs ${totals.resyncs}, unexpected closes ${totals.closedUnexpectedly}, errors ${totals.errors.length}`);
  for (const e of report.errors) console.log(`  ! ${e}`);

  const json = arg('json', resolve(APP_ROOT, `data/loadtest-${players}.json`));
  writeFileSync(json, JSON.stringify(report, null, 2));
  console.log(`wrote ${json}`);

  server?.kill();
  const pass = lat.all.p95 < 150 && totals.errors.length === 0 && totals.closedUnexpectedly === 0;
  console.log(pass ? 'PASS (p95 < 150 ms, no errors)' : 'FAIL');
  process.exit(pass ? 0 : 1);
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runWorker();
}
