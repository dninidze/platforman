# Stress test: 9,900 simulated players in the page

Spec §0 replaces the WebSocket load test with an in-page stress mode. The acceptance target (amended
criterion 1) is: engine and UI stay in sync under 9,900 bots at ≥ 50 FPS on a typical laptop, and every tick
lands within ±50 ms.

## How it is measured

Open `dist/platform3.html`, then **Settings → Performance overlay** (or add `?perf`), then **Stress test
(9,900 bots)**. The recorder sets the bot count to 9,900 and records N full rounds:

* **FPS**: frames counted with `requestAnimationFrame` in 1-second windows on the UI thread.
* **Tick fire vs schedule (engine)**: for every tick, the engine's actual timer fire time minus the
  tick's scheduled time (`hostStats.tickLateness`, measured inside the worker).
* **Tick → UI (delivery)**: `Date.now()` when the UI receives the tick minus the tick's scheduled
  `serverTime`. This includes the worker → page hop and the UI's own event-loop delay.
* **Sync**: every tick carries a checksum of all 100 tile counts as the engine holds them. The UI
  recomputes it from its own state after applying the tick's delta. A mismatch is counted (and triggers
  a resync).
* **Engine busy**: share of wall time the worker spends in timer callbacks.

`npm run check:stress -- 3 [--cpu=4] [--headed]` (`scripts/stress-check.mjs`) automates this. It opens the
file from disk in Chrome with networking disabled (DevTools offline emulation, unreachable proxy, DNS
mapped to nowhere), joins, presses the button, and saves the recorder's JSON to
`data/stress-check-*.json`.

In the stress scenario each of the 9,900 bots bets €0.10–€20 on a popular-biased tile every round, so most
tiles sit at the 99-player cap and many bets and moves hit `TILE_FULL`. Bots hop tiles with 2% probability
per tick, react 40–320 ms after a tick (some moves land in the lock window and get `MOVE_LOCKED`), and cash
out at varied targets. That keeps rounds running into platforms 2 and 3.

## Results (2026-10-28, final build)

Machine: Windows 11 desktop, 32 logical cores, Chrome 156. Each run: 9,900 bots, 3 full rounds, 840 ticks,
about 7.5 minutes. The engine ran in the inlined Web Worker in all three runs.

| Run | FPS avg | FPS min (1 s window) | FPS p5 | Tick fire vs schedule p50 / p95 / max | Tick → UI p50 / p95 / max | Checksum mismatches | Engine busy avg / max | Network requests | Console errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Headless | 60.0 | 59.0 | 60.0 | 1 / 2 / 16 ms | 1 / 2 / 16 ms | 0 / 840 | 0.30% / 1.2% | 0 | 0 |
| Headed (real window) | 60.2 | 60.0 | 60.0 | 12 / 15 / 17 ms | 9 / 15 / 17 ms | 0 / 840 | 0.29% / 1.1% | 0 | 0 |
| Headless, UI thread throttled 4× ("typical laptop" proxy) | 59.8 | 49.8 (second 0 only) | 58 | 1 / 2 / 16 ms | 1 / 2 / 18 ms | 0 / 840 | 0.31% / 1.0% | 0 | 0 |

In the 4× run the only window below 57 FPS is the first second of the recording, when the stress button
adds 9,600 bots in one go (49.8 FPS). Every later second was 57–60 FPS.

**Verdict:** under 9,900 bots the UI stayed in sync on every tick (0 mismatches over 2,520 ticks), FPS stayed
at or above 50 except one 49.8 FPS second at the one-off bot spike in the throttled run, and every tick was
within +18 ms of its schedule (limit ±50 ms). The 15–17 ms maxima match the Windows default timer
resolution (~15.6 ms).

## Caveats

* No physical laptop was available. "Typical laptop" is approximated with DevTools CPU throttling (4×) on
  the page's main thread, on a fast desktop. Throttling is not documented to slow the dedicated engine
  worker, so the engine side of that run is unthrottled. Engine busy time is ~1% of one core at 9,900
  bots, so a 4× slower core still leaves headroom.
* Ticks never fire early (`setTimeout` semantics), so all lateness values are ≥ 0. The ±50 ms target is
  met as 0…+18 ms.
* An earlier headed run (before the final build) showed **1 checksum mismatch** in 840 ticks. Root cause:
  when a bot was force-cashed at `maxWinPerBet` (€20 × 500x in platform 3) or paid as a stage-3 survivor,
  its tile count changed without the tile being added to that tick's delta. Fixed in `room.ts` and covered
  by two new tests. All three runs above are on the fixed build.
* Before the fix that moved the worker to a classic (IIFE) bundle, Chrome refused the inlined *module*
  worker from `file://`, and the page silently fell back to running the engine on the main thread. It still
  played and verified, but the numbers above are all with the worker.

Raw results: `data/stress-check-headless-cpu1.json`, `data/stress-check-headed-cpu1.json`,
`data/stress-check-headless-cpu4.json` (gitignored; regenerate with `npm run check:stress`).
