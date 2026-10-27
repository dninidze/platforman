# Load test: 9,900 players in one room

Command (spec §13.9):

```bash
npm run bots -- --players 9900
```

What it does (`tools/bots/bots.ts`):

* Spawns a game server (`packages/server/src/main.ts`) with the default §12 timing (`tickMs` 500,
  `bettingMs` 10 000, `intermissionMs` 3 000, `resultsMs` 4 000, `moveLockMs` 100) and
  `ROOM_SOFT_CAP=9900`, so every bot lands in room `EUR-1`. Round logs go to `data/loadtest/`.
* Opens 9,900 WebSocket clients from 12 worker threads (ramp 400 connects/s; a refused connect is retried
  like a real client and counted separately).
* Each bot, every round: bets €0.10–€10.00 on a random non-full tile (retrying on `TILE_FULL`), picks a
  cash-out target (85% a random point in stage 1, 12% stage 2, 3% stage 3), hops to a random tile with
  probability 3% per tick (12% in intermission), and cashes out once the target is reached.
* After the ramp it waits for the in-progress round to finish, then measures the next 20 full rounds.
* Latency = time from sending `bet` / `move` / `cashout` to receiving the matching `*Result` (`rid`), measured
  in the bot process, so it includes the bot's own event-loop delay.
* Server CPU and memory come from the server's `/metrics` endpoint (`process.cpuUsage()` deltas once per
  second, `process.memoryUsage().rss`). CPU % is relative to one core (the room runs on one thread; the
  number includes the kernel time spent on socket writes).

## Results

RESULTS_PLACEHOLDER
