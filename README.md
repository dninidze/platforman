# Platform 3 – MVP

A server-authoritative multiplayer crash game. 100 tiles (10×10). Players bet on a tile, tiles go
**Gone** one by one every 0.5 s in a precommitted, provably fair order, and the multiplier climbs after
every removal. There are three platforms (stages): the board is resurrected after 91 and then 90 removals,
and anyone still standing on the last tile of stage 3 is paid 10,000x. Play money only.

Built from `../spec/BUILD_SPEC.md` and `../spec/multipliers.json` (copied verbatim into
`packages/shared/src/multipliers.json`; a unit test asserts they stay identical).

## Run it

Requires Node 20+ (developed on Node 24) and npm 10+.

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` starts the game server on <http://localhost:8080> (WebSocket at `/ws`) and the Vite client
on <http://localhost:5173>, which proxies `/ws` and `/api` to the server. Open two tabs, pick two
nicknames, and you are in the same room.

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (tsx watch) + client (Vite) together |
| `npm start` | Builds the client and serves it from the game server on :8080 |
| `npm test` | Vitest: shared engine, fairness, limits, capacity, fast finish, room manager, wallet, gateway |
| `npm run typecheck` | `tsc` (strict) over every package |
| `npm run sim` | Monte Carlo RTP check, 1M rounds by default (`-- --rounds N --seed hex --verbose --csv file`) |
| `npm run bots -- --players 9900` | Load test: spawns a server with `ROOM_SOFT_CAP=9900` and 9,900 bots in one room for 20 rounds |
| `npm run verify` | Re-verifies every round in `data/rounds.jsonl` (seed hash, 3 sequences, tick log, payouts) |

### Configuration

All values from spec §12 live in `packages/shared/src/constants.ts` and can be overridden with env vars
(`tickMs` → `TICK_MS`, `roomSoftCap` → `ROOM_SOFT_CAP`, …). Money env vars are in major units
(`MIN_BET=0.10`, `MAX_BET=100`, `MAX_WIN_PER_BET=10000`); internally all money is integer cents.
Extra server settings: `PORT` (8080), `DATA_DIR` (`data`), `OCCUPANCY_MS` (100), `LIVE_FEED_MS` (500),
`STARTING_BALANCE` (1000), `MOVES_PER_SECOND` (5), `EMPTY_ROUNDS_BEFORE_CLOSE` (3).

Example: a slower betting phase for manual testing:

```bash
BETTING_MS=30000 npm run dev
```

## Layout

```
packages/shared   constants, multiplier table + math, provably-fair derivation, RoundCore (pure engine),
                  protocol types, Clock (real + fake)
packages/server   Room (timeline, wallet, broadcasts), RoomManager, MockWallet, audit log, ws gateway, verifier
packages/client   Vite + React UI (plain DOM grid)
tools/sim         Monte Carlo RTP simulator (worker threads, real RoundCore + real seeds)
tools/bots        WebSocket load test (worker threads)
data/             rounds.jsonl, rejections.jsonl, server.log, sim/load-test outputs (gitignored)
```

### How a round runs

* `RoundCore` (shared) is a timer-free state machine: bets, moves, cashouts, `tick()`, stage change. It
  decides *what* happens. The simulator drives it directly; the server wraps it.
* `Room` (server) decides *when*. It keeps one scheduled event (betting end, next tick, intermission end,
  results end). **Every inbound action first calls `advance(now)`**, which runs every event whose scheduled
  time has passed, at its scheduled time. So an action that arrives after a tick's timestamp is always
  applied after that tick, even if the timer callback is late (tested with a fake clock). At each tick:
  apply queued actions → remove the next tile → resolve losers → update multiplier (+ max-win caps) →
  broadcast.
* Sequences are derived at round creation and held in server memory only. Snapshots carry the tiles
  *already* removed (`played`), never future ones; seeds and sequences are revealed in `roundEnd`.
* Each round appends one JSONL line to `data/rounds.jsonl` (seed hash, revealed seed, client seed,
  sequences, played tiles, timestamped ticks, each player's bet/moves/outcome/payout). Every rejected action
  goes to `data/rejections.jsonl` with its reason.

## Provably fair

* `serverSeed`: 32 random bytes as 64 lowercase hex chars.
* `serverSeedHash = hex(SHA-256(utf8(serverSeed)))`: the **hex string** is hashed, so any SHA-256 tool can
  check it.
* `clientSeed = "<roundId>:<nonce>"` where the nonce is the room's public round counter (pluggable
  `ClientSeedProvider`; no player input in the MVP).
* For stage `s`, a stream of `HMAC-SHA256(key = utf8(serverSeed), msg = "<clientSeed>:<s>:<counter>")`,
  counter from 0, is cut into big-endian uint32 chunks. A draw in `[0, n)` rejects values
  `>= floor(2^32 / n) * n` (no modulo bias). Forward Fisher–Yates: for `i = 0..98`, swap `i` with
  `i + draw(100 - i)`.
* Stage 1 uses the first 91 entries, stage 2 the first 90, stage 3 the first 99; entry 99 of the stage-3
  permutation is the 10,000x tile.
* The same code (`@noble/hashes`, isomorphic) runs on the server and in the browser's Fairness modal, which
  re-derives the hash and all three sequences for any logged round (fetched from `/api/rounds/:id`) and also
  checks them against the hash and tiles that browser itself saw during the round.

## Protocol notes (additions to spec §8)

* Client actions may carry `rid`; the matching `*Result` echoes it (used for latency measurement).
* `resync {}` asks for a snapshot after a `seq` gap; `ping {at}` → `pong`.
* `cancelBet` answers with `cancelResult`. `rooms {rooms, home, watching}` is sent on join/spectate.
* Extra error codes: `RATE_LIMIT`, `BAD_REQUEST`, `NOT_JOINED`, `NO_ROOM`, `WALLET_ERROR`.
* `countsDelta` is a flat list `[tileId, count, tileId, count, …]`; `goneMask` is 25 hex chars (bit *i* =
  tile *i*). `roundState.tiles` is the 100 counts as an array.
* Room broadcasts carry a per-room `seq`. Snapshots carry the current `seq`. The server skips room
  broadcasts to a socket with more than 1 MB unsent; that client sees the gap and resyncs.
* HTTP: `/metrics`, `/api/rooms`, `/api/history?roomId=`, `/api/rounds?roomId=&limit=`, `/api/rounds/:id`.

## Open questions (spec §14): defaults used

| # | Question | Default built |
| --- | --- | --- |
| 1 | Betting-phase length | 10 s (`BETTING_MS`) |
| 2 | Cash out during intermission? | Yes, at the stage's final multiplier (10.77x / 104.46x) |
| 3 | Cash out before the first tile goes? | No. 1.00x is shown and the button stays disabled (`PHASE`) |
| 4 | One bet or two per round? | One |
| 5 | Show nicknames on tiles? | No, counts only. Nicknames appear only in the live feed's top cashouts |
| 6 | `roomSoftCap` | 2,000 (`ROOM_SOFT_CAP`); see `LOADTEST.md` for the 9,900 single-room numbers |
| 7 | House-edge flattening | Not touched. Multipliers are exactly `spec/multipliers.json` |

## Interpretations of ambiguous points

1. **First removal timing.** The first tile of each stage goes `tickMs` after RUNNING starts (after
   betting ends, or after intermission ends). During the first 500 ms of stage 2/3 the multiplier shown and
   paid is the previous stage's final value.
2. **Resurrection moment.** All tiles come back at the *start* of intermission, so survivors can move to
   any tile during the "Resurrection" countdown.
3. **Move lock.** A move is `MOVE_LOCKED` when the next tick is less than `moveLockMs` away
   (`nextTickAt - now < 100`). It applies to every RUNNING tick, fast mode included. Betting and intermission
   have no imminent removal, so they are never locked. Cashouts are never locked.
4. **Fast finish.** When the board empties during RUNNING, the next tick happens at
   `min(scheduled tick, now + fastTickMs)`, then every 200 ms to the end of that stage, then ENDED. If the
   board empties during intermission (everyone cashed out), the round ends immediately. A round with no bets
   runs stage 1 at 200 ms from the first tick. Order is always the precommitted one (tested).
5. **Max win.** `payout = min(floor(bet × multiplier), maxWinPerBet)` for cashouts, forced cashouts and the
   10,000x survivors. A player is force-cashed on the tick where `bet × multiplier` reaches the cap. With
   the default limits (€10,000 cap) only bets of €1.00 or more can reach it (on the last stage-3 tile at
   10,000x); bets of €95.73 or more reach it at the end of stage 2. No round-wide cap exists.
6. **History entry.** Each finished round shows its 10,000x tile (from the revealed seed) and either
   "no survivors at P*N*" (the stage in which the board emptied) or how many players won 10,000x.
7. **Changing tile during betting** uses the normal `move` message. Changing the amount = cancel + bet.
8. **Seat reservation.** A bet takes its tile seat at arrival (first come, first served) and then
   debits the wallet; a failed debit releases the seat. Cancel uses `wallet.rollback(betTx)`.
9. **Disconnects.** A disconnected player's bet stays on the board and rides. Reconnecting with the same
   nickname returns them to the same room. Joining with a nickname that is already connected (another tab)
   takes over that session and closes the old socket.
10. **Room assignment** counts connected members, not bettors. Ties go to the oldest room. An extra room
    closes after 3 consecutive rounds with no members; the last room never closes.
11. **Credit retries.** Failed credits are retried with the same `txId` after 0.1, 0.5, 2, 5 and 10 s, each
    failure is logged (`credit_failed`), then `credit_abandoned` is logged for manual reconciliation.
12. **Rate limits.** Moves: 5/s per socket (token bucket). All messages: 30/s with a burst of 60.
13. **Client display.** The cash-out button shows `floor(bet × current multiplier)` using the shared
    `payout()` helper. That is display only: the amount paid is the one in `cashoutResult`.
14. **Simulator bet size.** The simulator bets €1, so `maxWinPerBet` never binds and empirical RTP is
    comparable with the uncapped §4 figures.
15. Spec §0 says to ask the product owner where the spec and the `.docx` disagree. This build follows the
    spec (and `multipliers.json`) only; the `.docx` was not consulted.

## Acceptance criteria (§13)

See the bottom of `LOADTEST.md` and the session report for how each was verified.
