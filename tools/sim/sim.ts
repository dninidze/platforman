/**
 * Monte Carlo RTP simulator. Drives the real shared RoundCore with real provably-fair sequences.
 *
 *   npm run sim -- [--rounds 1000000] [--workers N] [--seed hex] [--verbose] [--csv path]
 *
 * Strategies (one player each per round, bet = 0.50):
 *   - cash out after the k-th removal of stage s, for every (s, k)   (280 strategies)
 *   - random walk: random target among those 280 points, hops to a random tile with p=0.5 each tick
 *   - ride: never cash out (only the 10,000x survivor pays)
 * Exits non-zero if any strategy's empirical RTP is more than 4 standard errors from theory
 * (standard error from the theoretical variance of that strategy's payout).
 */
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  DEFAULT_CONFIG,
  RoundCore,
  STAGE_REMOVALS,
  deriveSequences,
  hardTileCap,
  getMultiplier,
  generateServerSeed,
  hashServerSeed,
  theoreticalRtp,
  type Stage,
} from '@p3/shared';

// €0.50: even 10,778x stays under the €10,000 max win per bet, so the sim measures the uncapped table.
const BET = 50;
const POINTS: { stage: Stage; k: number }[] = [];
for (let s = 1; s <= 3; s++) for (let k = 1; k <= STAGE_REMOVALS[s - 1]; k++) POINTS.push({ stage: s as Stage, k });
const N_STRAT = POINTS.length + 2; // + random walk + ride
const WALK = POINTS.length;
const RIDE = POINTS.length + 1;

interface Acc {
  n: number;
  sum: Float64Array;
  sumSq: Float64Array;
}

function simulate(seed: string, from: number, to: number, rng: () => number): Acc {
  const sum = new Float64Array(N_STRAT);
  const sumSq = new Float64Array(N_STRAT);
  // Same limits as a room: no fixed per-tile maximum (CHANGES_4 §3); the sim never moves onto locked tiles anyway.
  const limits = { ...DEFAULT_CONFIG, tileCapacity: hardTileCap(DEFAULT_CONFIG.tileCapacity) };
  // Players to cash out after each (stage, k): index = stageOffset + k.
  const offset = [0, STAGE_REMOVALS[0], STAGE_REMOVALS[0] + STAGE_REMOVALS[1]];
  const ids = Array.from({ length: N_STRAT }, (_, i) => `s${i}`);

  for (let r = from; r < to; r++) {
    const serverSeed = hashServerSeed(`${seed}:${r}`);
    const core = new RoundCore(deriveSequences(serverSeed, `sim#${r}:${r}`), limits);
    for (let i = 0; i < N_STRAT; i++) {
      let tile = Math.floor(rng() * 100);
      while (core.isFull(tile)) tile = (tile + 1) % 100;
      core.placeBet(ids[i], BET, tile);
    }
    const walkTarget = Math.floor(rng() * POINTS.length);
    core.startRunning();
    for (;;) {
      const t = core.tick();
      const idx = offset[t.stage - 1] + t.k - 1;
      core.cashout(ids[idx]);
      if (idx === walkTarget) core.cashout(ids[WALK]);
      const walker = core.players.get(ids[WALK])!;
      if (walker.state === 'alive' && rng() < 0.5) {
        const to = Math.floor(rng() * 100);
        core.move(ids[WALK], to); // rejected moves (Gone/Full) are fine: they are part of the walk
      }
      if (core.phase === 'ended') break;
      if (core.phase === 'intermission') {
        if (core.onBoard === 0) break;
        core.startNextStage();
      } else if (core.onBoard === 0) break; // fast finish: nobody left, outcomes are settled
    }
    for (let i = 0; i < N_STRAT; i++) {
      const x = core.players.get(ids[i])!.payout / BET;
      sum[i] += x;
      sumSq[i] += x * x;
    }
  }
  return { n: to - from, sum, sumSq };
}

/** xorshift128+ seeded from a string, for player choices (tile picks, walk). */
function makeRng(seedHex: string): () => number {
  let a = BigInt('0x' + seedHex.slice(0, 16)) | 1n;
  let b = BigInt('0x' + seedHex.slice(16, 32)) | 1n;
  const M = (1n << 64n) - 1n;
  return () => {
    let x = a;
    const y = b;
    a = y;
    x ^= (x << 23n) & M;
    b = x ^ y ^ (x >> 17n) ^ (y >> 26n);
    return Number(((b + y) & M) >> 11n) / 2 ** 53;
  };
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

if (!isMainThread) {
  const { seed, from, to } = workerData as { seed: string; from: number; to: number };
  const acc = simulate(seed, from, to, makeRng(hashServerSeed(`${seed}:rng:${from}`)));
  parentPort!.postMessage(acc);
} else {
  void main();
}

async function main() {
  const rounds = Number(arg('rounds', '1000000'));
  const workers = Math.max(1, Math.min(Number(arg('workers', String(Math.min(16, availableParallelism() - 1)))), rounds));
  const seed = arg('seed') ?? generateServerSeed();
  const verbose = process.argv.includes('--verbose');
  const t0 = performance.now();
  console.log(`Platform 3 RTP simulator: ${rounds.toLocaleString()} rounds, ${workers} workers, seed ${seed}`);

  const chunk = Math.ceil(rounds / workers);
  const parts = await Promise.all(
    Array.from({ length: workers }, (_, w) => {
      const from = w * chunk;
      const to = Math.min(rounds, from + chunk);
      return new Promise<Acc>((resolve, reject) => {
        const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { seed, from, to }, execArgv: ['--import', 'tsx'] });
        worker.once('message', resolve);
        worker.once('error', reject);
      });
    }),
  );
  const n = parts.reduce((a, p) => a + p.n, 0);
  const sum = new Float64Array(N_STRAT);
  const sumSq = new Float64Array(N_STRAT);
  for (const p of parts) for (let i = 0; i < N_STRAT; i++) (sum[i] += p.sum[i]), (sumSq[i] += p.sumSq[i]);

  // Theoretical mean and E[X^2] per unit bet. A cashout point pays m with probability p, else 0.
  const theo = POINTS.map((p) => theoreticalRtp(p.stage, p.k));
  const second = POINTS.map((p) => theoreticalRtp(p.stage, p.k) * getMultiplier(p.stage, p.k));
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  theo.push(avg(theo), theoreticalRtp(3, 99)); // walk: uniform random target; ride: the 10,000x path
  second.push(avg(second), theoreticalRtp(3, 99) * getMultiplier(3, 99));
  const name = (i: number) => (i < POINTS.length ? `S${POINTS[i].stage} k=${POINTS[i].k}` : i === WALK ? 'random walk + moves' : 'ride to 10,000x');

  interface Row {
    i: number;
    name: string;
    emp: number;
    lo: number;
    hi: number;
    theo: number;
    z: number;
  }
  const rows: Row[] = [];
  for (let i = 0; i < N_STRAT; i++) {
    const mean = sum[i] / n;
    const variance = Math.max(0, sumSq[i] / n - mean * mean);
    const se = Math.sqrt(variance / n);
    // z uses the standard error under the null (theoretical variance): it stays defined for rare
    // events that may not occur at all in a short run.
    const se0 = Math.sqrt((second[i] - theo[i] * theo[i]) / n);
    const z = (mean - theo[i]) / se0;
    rows.push({ i, name: name(i), emp: mean, lo: mean - 1.96 * se, hi: mean + 1.96 * se, theo: theo[i], z });
  }

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`.padStart(8);
  const line = (r: Row) =>
    `${r.name.padEnd(22)} ${pct(r.emp)}  [${pct(r.lo)} ..${pct(r.hi)}]  theory ${pct(r.theo)}  z=${r.z.toFixed(2).padStart(6)}${Math.abs(r.z) > 4 ? '  FAIL' : ''}`;

  console.log(`\n${'strategy'.padEnd(22)} ${'RTP'.padStart(8)}  ${'95% CI'.padEnd(22)} ${'theory'.padStart(15)}`);
  for (let s = 1; s <= 3; s++) {
    const stageRows = rows.filter((r) => r.i < POINTS.length && POINTS[r.i].stage === s);
    const show = verbose
      ? stageRows
      : [
          stageRows[0],
          stageRows.reduce((a, b) => (b.theo < a.theo ? b : a)),
          stageRows.reduce((a, b) => (b.theo > a.theo ? b : a)),
          stageRows.at(-1)!,
          stageRows.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a)),
        ].filter((r, idx, arr) => arr.findIndex((x) => x.i === r.i) === idx);
    console.log(`-- stage ${s} (${verbose ? 'all k' : 'first, min theory, max theory, last, worst |z|'})`);
    for (const r of show) console.log(line(r));
    const tmin = Math.min(...stageRows.map((r) => r.theo));
    const tmax = Math.max(...stageRows.map((r) => r.theo));
    const emin = Math.min(...stageRows.map((r) => r.emp));
    const emax = Math.max(...stageRows.map((r) => r.emp));
    console.log(`   theory range ${pct(tmin)} ..${pct(tmax)}   empirical range ${pct(emin)} ..${pct(emax)}`);
  }
  console.log('-- other strategies');
  console.log(line(rows[WALK]));
  console.log(line(rows[RIDE]));

  const fails = rows.filter((r) => !(Math.abs(r.z) <= 4));
  const worst = rows.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a));
  const secs = (performance.now() - t0) / 1000;
  console.log(
    `\n${rows.length} strategies, worst |z| = ${Math.abs(worst.z).toFixed(2)} (${worst.name}); ` +
      `${fails.length} beyond 4 sigma. ${n.toLocaleString()} rounds in ${secs.toFixed(1)} s.`,
  );
  const csvArg = arg('csv');
  // npm runs workspace scripts in the workspace folder; resolve against where the user ran npm.
  const csv = csvArg && resolve(process.env.INIT_CWD ?? process.cwd(), csvArg);
  if (csv) {
    writeFileSync(csv, 'strategy,empirical,ci_lo,ci_hi,theory,z\n' + rows.map((r) => [r.name, r.emp, r.lo, r.hi, r.theo, r.z].join(',')).join('\n') + '\n');
    console.log(`wrote ${csv}`);
  }
  if (fails.length) {
    console.log(`FAIL: ${fails.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
  console.log('PASS');
}
