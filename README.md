# Platform 3 – MVP

A multiplayer crash game. 100 tiles (10×10). Players bet on a tile, tiles go **Gone** one by one every
0.5 s in a precommitted, provably fair order, and the multiplier climbs after every removal. There are
three platforms (stages): the board is resurrected after 91 and then 90 removals, and anyone still standing
on the last tile of stage 3 is paid 10,000x. Play money only.

Built from `../spec/BUILD_SPEC.md` (including **§0: one self-contained HTML file**) and
`../spec/multipliers.json` (copied verbatim into `packages/shared/src/multipliers.json`; a unit test asserts
they stay identical).

## The deliverable

**`dist/platform3.html`** (about 280 KB): open it by double-click. Everything is inlined: React UI, CSS,
the game engine (as an inlined Web Worker) and the multiplier table. It makes no network requests and
works with networking disabled (checked with `npm run check:offline`, below).

1. Enter a nickname. New nicknames get €1,000 of play money; the balance is kept in `localStorage` (if
   the browser allows it) and can be reset in **Settings**.
2. During betting, tap a tile, set an amount and press **Bet**. Tap another tile to move.
3. While tiles go, press **Cash out** before your tile goes Gone, or ride all three platforms.
4. **Settings**: number of simulated players (0–9,900, default 300), "simulate busy server" (shards bots
   into extra rooms past `roomSoftCap`), performance overlay with the stress test, reset balance, download
   the round log (JSONL).
5. **Fair**: verify any finished round offline with Web Crypto.

URL options: `?perf` opens the performance overlay; `?engine=main` runs the engine on the main thread
instead of a worker; `?server=ws://host/ws` would use a real WebSocket game server (not part of the MVP).

## Build and run

Requires Node 20+ (developed on Node 24) and npm 10+.

```bash
npm install
```

```bash
npm run build
```

| Command | What it does |
| --- | --- |
| `npm run build` | Builds `dist/platform3.html` (Vite + `vite-plugin-singlefile`) and fails if any external `src`/`href` remains or the file exceeds 2 MB |
| `npm run dev` | Vite dev server on <http://localhost:5173> (same app, engine in a worker) |
| `npm test` | Vitest: shared engine, fairness (incl. Web Crypto parity), limits, capacity, fast finish, room manager, wallet, in-page host and bots |
| `npm run typecheck` | `tsc` (strict) over every package |
| `npm run sim` | Monte Carlo RTP check in Node, 1M rounds by default (`-- --rounds N --seed hex --verbose --csv file`) |
| `npm run check:offline` | Opens `dist/platform3.html` from disk in headless Chrome/Edge with networking disabled, plays a full round through the UI, runs the verifier, and reports any network request |
| `npm run check:stress` | Same harness: 9,900 bots for N rounds via the in-page stress recorder (`-- 5 --headed`) |
| `npm run verify -- file.jsonl` | Re-verifies every round in a downloaded round log (seed hash, 3 sequences, tick log, payouts) |

## Layout

```
packages/shared   constants, multiplier table + math, provably-fair derivation (noble, sync) and an
                  independent Web Crypto version, RoundCore (pure engine), protocol types, Clock (real + fake)
packages/engine   Room (timeline, wallet, broadcasts), RoomManager (sharding), MockWallet, audit log,
                  BotDriver (simulated players), LocalHost (the in-page "server" speaking the §8 protocol)
packages/client   React UI, transports (Web Worker / main thread / WebSocket), engine worker entry
tools/sim         Monte Carlo RTP simulator (Node, worker threads, real RoundCore + real seeds)
scripts/          headless-browser checks (offline round, stress)
dist/             platform3.html (committed); data/ holds local run outputs (gitignored)
```

### How it fits together

* The UI talks to the engine only through a `Transport` that carries §8 protocol messages
  (`packages/client/src/transport.ts`). The default `WorkerTransport` runs `LocalHost` in an inlined Web
  Worker, so removal sequences live only in the worker's memory until a round is revealed. If the worker
  cannot start, `InProcessTransport` runs the same host on the main thread behind the same message
  boundary. `WebSocketTransport` is there for a future real server: swapping it in needs no UI change.
* `RoundCore` (shared) is a timer-free state machine: bets, moves, cashouts, `tick()`, stage change. It
  decides *what* happens. The simulator drives it directly.
* `Room` (engine) decides *when*. It keeps one scheduled event (betting end, next tick, intermission end,
  results end). Every inbound action first calls `advance(now)`, which runs every event whose time has
  passed at its scheduled time, so an action that arrives after a tick's timestamp is applied after that
  tick even if the timer fires late (tested with a fake clock). Each tick: apply queued actions → remove the
  next tile → resolve losers → update multiplier (+ max-win caps) → broadcast.
* `LocalHost` replaces the WebSocket gateway: joins, spectating, rate limits, settings, logs and stats.
  `RoomManager` shards players over rooms by `roomSoftCap`; the page shows the player's room and lists the
  others.
* `BotDriver` adds simulated players as ordinary room members acting through the same `Room` API (same
  limits, `MOVE_LOCKED`, `TILE_FULL`). They see only public state (counts, Gone tiles, phase) and their own
  bet, never the sequence. They favour popular tiles (corners, centre, 7/13/21/33/77/88/100), bet
  €0.10–€20, react 40–320 ms after a tick, hop tiles, and cash out at varied targets (80% in platform 1, 15%
  in platform 2, 5% in platform 3, 1% ride for 10,000x).
* Every tick carries a checksum of all 100 counts. The UI recomputes it after applying the deltas; a
  mismatch counts in the overlay and triggers a resync. This is how "engine and UI stay in sync" is measured.
* The engine keeps the last 300 round records (seed hash, revealed seed, client seed, sequences, played
  tiles, timestamped ticks, each player's bet/moves/outcome/payout) and the last 500 rejected actions with
  reasons. Settings → Download round log exports them as JSONL.

## Provably fair

* `serverSeed`: 32 random bytes as 64 lowercase hex chars (`crypto.getRandomValues`).
* `serverSeedHash = hex(SHA-256(utf8(serverSeed)))`: the **hex string** is hashed, so any SHA-256 tool can
  check it.
* `clientSeed = "<roundId>:<nonce>"`, where the nonce is the room's public round counter (pluggable
  `ClientSeedProvider`; no player input in the MVP).
* For stage `s`, a stream of `HMAC-SHA256(key = utf8(serverSeed), msg = "<clientSeed>:<s>:<counter>")`,
  counter from 0, is cut into big-endian uint32 chunks. A draw in `[0, n)` rejects values
  `>= floor(2^32 / n) * n` (no modulo bias). Forward Fisher–Yates: for `i = 0..98`, swap `i` with
  `i + draw(100 - i)`.
* Stage 1 uses the first 91 entries, stage 2 the first 90, stage 3 the first 99; entry 99 of the stage-3
  permutation is the 10,000x tile.
* The engine derives sequences synchronously with `@noble/hashes`. The Fairness modal re-derives them with
  **Web Crypto** (`crypto.subtle`), an independent implementation, and compares them with the round log, with
  the hash this browser saw before the round, and with the tiles it saw go. A unit test checks both
  implementations agree on 200 random seeds. Web Crypto requires a secure context. `file://` qualifies in
  Chrome, Edge and Firefox (verified headless). In an opaque origin without it (for example a `data:` URL),
  the modal falls back to the bundled implementation and says so.

## Protocol notes (additions to spec §8)

* Client actions may carry `rid`; the matching `*Result` echoes it.
* `resync {}` asks for a snapshot after a `seq` gap; `ping {at}` → `pong`.
* `join` may carry `balance`: the page's persisted play-money balance, used to seed the wallet once.
* Local-host extensions: `settings {bots, busyServer, roomSoftCap}` (both directions), `resetBalance` →
  `balance`, `getHistory` → `history`, `getRound` → `roundRecord`, `getLog` → `log`, and `hostStats` once
  per second (tick lateness, engine busy share, rooms, reject counts).
* `tick.checksum`: order-sensitive checksum of the 100 counts after the tick.
* `cancelBet` answers with `cancelResult`. `rooms {rooms, home, watching}` is sent on join/spectate.
* Extra error codes: `RATE_LIMIT`, `BAD_REQUEST`, `NOT_JOINED`, `NO_ROOM`, `WALLET_ERROR`.
* `countsDelta` is a flat list `[tileId, count, …]`; `goneMask` is 25 hex chars (bit *i* = tile *i*).
  Room broadcasts carry a per-room `seq`; snapshots carry the current `seq`.

## Open questions (spec §14): defaults used

| # | Question | Default built |
| --- | --- | --- |
| 1 | Betting-phase length | 10 s |
| 2 | Cash out during intermission? | Yes, at the stage's final multiplier (10.77x / 104.46x) |
| 3 | Cash out before the first tile goes? | No. 1.00x is shown and the button stays disabled (`PHASE`) |
| 4 | One bet or two per round? | One |
| 5 | Show nicknames on tiles? | No, counts only. Nicknames appear only in the live feed's top cashouts |
| 6 | `roomSoftCap` | 2,000, editable in Settings; it only applies with "simulate busy server" on |
| 7 | House-edge flattening | Not touched. Multipliers are exactly `spec/multipliers.json` |

## Interpretations of ambiguous points

1. **First removal timing.** The first tile of each stage goes `tickMs` after RUNNING starts (after
   betting ends, or after intermission ends). During the first 500 ms of stage 2/3 the multiplier shown and
   paid is the previous stage's final value.
2. **Resurrection moment.** All tiles come back at the *start* of intermission, so survivors can move to
   any tile during the "Resurrection" countdown. "Next" then shows the next platform's first multiplier.
3. **Move lock.** A move is `MOVE_LOCKED` when the next tick is less than `moveLockMs` away. It applies to
   every RUNNING tick, fast mode included. Betting and intermission have no imminent removal, so they are
   never locked. Cashouts are never locked.
4. **Fast finish.** When the board empties during RUNNING, the next tick happens at
   `min(scheduled tick, now + fastTickMs)`, then every 200 ms to the end of that stage, then ENDED. If the
   board empties during intermission, the round ends immediately. A round with no bets runs stage 1 at
   200 ms from the first tick. Order is always the precommitted one (tested).
5. **Max win.** `payout = min(floor(bet × multiplier), maxWinPerBet)` for cashouts, forced cashouts and the
   10,000x survivors. A player is force-cashed on the tick where `bet × multiplier` reaches the cap. With
   the default €10,000 cap only bets of €1.00 or more can reach it (on the last stage-3 tile); bets of €95.73
   or more reach it at the end of stage 2. No round-wide cap exists.
6. **History entry.** Each finished round shows its 10,000x tile (from the revealed seed) and either
   "no survivors at P*N*" (the stage in which the board emptied) or how many players won 10,000x.
7. **Changing tile during betting** uses the normal `move` message. Changing the amount = cancel + bet.
8. **Seat reservation.** A bet takes its tile seat at arrival (first come, first served) and then debits
   the wallet; a failed debit releases the seat. Cancel uses `wallet.rollback(betTx)`.
9. **Rooms in a single page.** With "simulate busy server" off, everyone (player + bots) shares one room;
   tile capacity still caps seated players at 9,900. With it on, `roomSoftCap` applies: bots fill the
   fullest open room up to the cap and further rooms open (and close again after 3 empty rounds). The page
   plays the player's room; others can be spectated from the Rooms panel.
10. **Wallet persistence.** The engine (in the worker) cannot read `localStorage`, so the page stores the
    balance after every update and passes it in `join`. It seeds the wallet once per engine lifetime.
11. **Credit retries.** Failed credits are retried with the same `txId` after 0.1, 0.5, 2, 5 and 10 s, each
    failure is logged (`credit_failed`), then `credit_abandoned` is logged for manual reconciliation.
12. **Rate limits.** Moves: 5/s (token bucket). All messages: 30/s with a burst of 60.
13. **Client display.** The cash-out button shows `floor(bet × current multiplier)` using the shared
    `payout()` helper. That is display only; the amount paid is the one in `cashoutResult`.
14. **"Every tick lands within ±50 ms"** is measured twice: in the engine (timer fire time minus scheduled
    time) and in the UI (receipt time minus scheduled time). See `LOADTEST.md`.
15. **Sounds/fonts.** The page uses system fonts and has no sound, so there is nothing else to inline.
16. **Simulator bet size.** The simulator bets €1, so `maxWinPerBet` never binds and empirical RTP is
    comparable with the uncapped §4 figures.
17. Spec §0 (before it) says to ask the product owner where the spec and the `.docx` disagree. This build
    follows the spec and `multipliers.json` only; the `.docx` was not consulted.

## Acceptance criteria (§13 as amended by §0)

| # | Criterion | How it is verified |
| --- | --- | --- |
| 1 | Engine and UI in sync under 9,900 bots at ≥ 50 FPS, ticks within ±50 ms | Tick checksums (UI vs engine) in `host.test.ts` with 9,900 bots and two connections; in-browser stress run, see `LOADTEST.md` |
| 2 | Three stages end to end, survivors paid 10,000x (subject to cap) | `room.test.ts` "all three stages end to end", engine tests |
| 3 | Cashout pays `floor(bet × table[stage][k-1])` | `room.test.ts` (every k of stage 1, odd bets), `math.test.ts` (every table value vs BigInt) |
| 4 | 99 per tile; 100th rejected at bet and move | `room.test.ts`, `engine.test.ts` |
| 5 | Fast finish at 5/s in precommitted order, then ENDED | `room.test.ts` "fast finish" (4 cases) |
| 6 | `MOVE_LOCKED`, `TOO_LATE`, no double pay | `room.test.ts`, `wallet.test.ts` (idempotency, retries with same txId) |
| 7 | Verifier matches every sequence for any logged round | Fairness modal (Web Crypto), `host.test.ts` (`checkRecord` on every logged round), `npm run verify` |
| 8 | `npm run sim` passes | 1M rounds in 33 s, 282 strategies (every cash-out point, random walk with moves, ride to 10,000x), worst \|z\| 3.09, none beyond 4σ |
| 9 | In-page stress result recorded | `LOADTEST.md` |
| 10 | New room past `roomSoftCap` | `roomManager.test.ts`, `host.test.ts` "simulate busy server" |
| 11 | `npm test` green | 67 tests in 7 files |
| new | Plays a full round from disk with networking off | `npm run check:offline` |
