import {
  RoundCore,
  defaultClientSeedProvider,
  derivePermutations,
  encodeGoneMask,
  generateServerSeed,
  hashServerSeed,
  jackpotTile,
  payout,
  STAGE_REMOVALS,
  countsChecksum,
  roundHighlights,
  type RoundHighlights,
  tileCapsFor,
  hardTileCap,
  type TileCaps,
  maskName,
  type BroadcastMessage,
  type ClientSeedProvider,
  type Clock,
  type CountsDelta,
  type ErrorCode,
  type GameConfig,
  type LiveFeedMsg,
  type RoundPlayer,
  type RoundStateMsg,
  type ServerMessage,
  type Stage,
  type TimerHandle,
  type YouMsg,
} from '@p3/shared';
import type { AuditLog, PlayerAudit, RoundRecord } from './audit';
import type { Wallet } from './wallet';

export interface RoomSink {
  broadcast(roomId: string, msg: BroadcastMessage): void;
  sendToPlayer(playerId: string, msg: ServerMessage): void;
}

export interface Member {
  playerId: string;
  nickname: string;
}

export type Reply<T = object> = ({ ok: true } & T) | { ok: false; reason: ErrorCode };

export interface RoundSummary {
  roundId: string;
  jackpotTile: number;
  emptiedAtStage: Stage | null;
  survivors: number;
  players: number;
  endedAt: number;
  highlights: RoundHighlights;
}

export interface RoomDeps {
  config: GameConfig;
  clock: Clock;
  wallet: Wallet;
  sink: RoomSink;
  audit: AuditLog;
  seedProvider?: ClientSeedProvider;
  /** Test hook: fixed server seeds, consumed one per round. */
  seedSource?: () => string;
  onRoundEnd?: (room: Room) => void;
}

const CREDIT_RETRY_MS = [100, 500, 2_000, 5_000, 10_000];
/** Rows in the public players list. */
const LIST_LIMIT = 50;

/** The `n` largest by `key`, without sorting the whole group. */
function topBy<T>(items: T[], key: (x: T) => number, n: number): T[] {
  if (n <= 0) return [];
  if (items.length <= n * 4) return [...items].sort((a, b) => key(b) - key(a)).slice(0, n);
  const out: T[] = [];
  for (const it of items) {
    if (out.length < n) {
      out.push(it);
      if (out.length === n) out.sort((a, b) => key(b) - key(a));
    } else if (key(it) > key(out[n - 1])) {
      let i = n - 1;
      while (i > 0 && key(out[i - 1]) < key(it)) i--;
      out.splice(i, 0, it);
      out.pop();
    }
  }
  return out;
}

/**
 * One room = one authoritative round timeline. Single-threaded: every inbound action first runs
 * all events whose scheduled time has passed (advance), so ordering always follows timestamps.
 */
export class Room {
  readonly members = new Map<string, Member>();
  readonly history: RoundSummary[] = [];
  core!: RoundCore;
  roundId = '';
  roundNo = 0;
  seq = 0;
  fast = false;
  emptyRounds = 0;
  closed = false;

  /** End of betting / intermission / results; null while running. */
  phaseEndsAt: number | null = null;
  nextTickAt: number | null = null;

  private serverSeed = '';
  private serverSeedHash = '';
  private clientSeed = '';
  private permutations: number[][] = [];
  private createdAt = 0;
  private runningAt: number | null = null;
  private fastFrom: RoundRecord['fastFrom'] = null;
  private ticks: RoundRecord['ticks'] = [];
  private audits = new Map<string, PlayerAudit>();
  private betSeq = new Map<string, number>();
  private pendingDebits = new Map<string, { aborted: boolean }>();
  private dirty = new Set<number>();
  /** Frozen thresholds once the round runs (null during betting: computed live). */
  private caps: TileCaps | null = null;
  private feedDirty = true;
  private topCashouts: LiveFeedMsg['topCashouts'] = [];
  private timer: TimerHandle | null = null;
  private occTimer: TimerHandle | null = null;
  private feedTimer: TimerHandle | null = null;

  constructor(
    readonly id: string,
    readonly currency: string,
    private readonly deps: RoomDeps,
  ) {}

  get config(): GameConfig {
    return this.deps.config;
  }
  get phase() {
    return this.core.phase;
  }

  /** This round's dynamic tile capacity (CHANGES_3 §2). */
  get tileCaps(): TileCaps {
    if (this.caps) return { ...this.caps };
    const { tileCapPct, tileYellowPct } = this.config;
    return tileCapsFor(this.core.players.size, tileCapPct, tileYellowPct, true);
  }

  start(): void {
    const { clock, config } = this.deps;
    this.newRound(clock.now());
    this.schedule();
    this.occTimer = clock.setInterval(() => this.flushOccupancy(), config.occupancyMs);
    this.feedTimer = clock.setInterval(() => this.flushFeed(), config.liveFeedMs);
  }

  close(): void {
    this.closed = true;
    const { clock } = this.deps;
    clock.clearTimeout(this.timer);
    clock.clearInterval(this.occTimer);
    clock.clearInterval(this.feedTimer);
  }

  addMember(m: Member): void {
    this.members.set(m.playerId, m);
  }

  /** Leaving keeps any live bet on the board (it rides until it resolves). */
  removeMember(playerId: string): void {
    this.members.delete(playerId);
  }

  // ------------------------------------------------------------------ timeline

  /** Run every scheduled event due at or before `now`, at its own scheduled time. */
  advance(now: number = this.deps.clock.now()): void {
    if (this.closed) return;
    for (let guard = 0; guard < 10_000 && !this.closed; guard++) {
      const at = this.nextEventAt();
      if (at === null || at > now) break;
      this.runEvent(at);
    }
    this.schedule();
  }

  private nextEventAt(): number | null {
    return this.core.phase === 'running' ? this.nextTickAt : this.phaseEndsAt;
  }

  private schedule(): void {
    const { clock } = this.deps;
    clock.clearTimeout(this.timer);
    this.timer = null;
    const at = this.nextEventAt();
    if (at === null || this.closed) return;
    this.timer = clock.setTimeout(() => this.advance(clock.now()), at - clock.now());
  }

  private runEvent(at: number): void {
    switch (this.core.phase) {
      case 'betting':
        return this.startRunning(at);
      case 'running':
        return this.doTick(at);
      case 'intermission':
        return this.startNextStage(at);
      case 'ended':
        return this.newRound(at);
    }
  }

  private interval(): number {
    return this.fast ? this.config.fastTickMs : this.config.tickMs;
  }

  private newRound(at: number): void {
    const { seedProvider = defaultClientSeedProvider, seedSource = generateServerSeed } = this.deps;
    this.roundNo++;
    this.roundId = `${this.id}#${this.roundNo}`;
    this.serverSeed = seedSource();
    this.serverSeedHash = hashServerSeed(this.serverSeed);
    this.clientSeed = seedProvider.clientSeedFor(this.roundId, this.roundNo);
    this.permutations = derivePermutations(this.serverSeed, this.clientSeed);
    const { tileCapacity, minBet, maxBet, maxWinPerBet } = this.config;
    // CHANGES_4 §3: no per-tile limit while betting (only an optional fixed maximum).
    this.core = new RoundCore(this.permutations, { tileCapacity: hardTileCap(tileCapacity), minBet, maxBet, maxWinPerBet });
    this.caps = null;
    this.createdAt = at;
    this.runningAt = null;
    this.fast = false;
    this.fastFrom = null;
    this.ticks = [];
    this.audits = new Map();
    this.betSeq = new Map();
    this.dirty.clear();
    this.topCashouts = [];
    this.feedDirty = true;
    this.phaseEndsAt = at + this.config.bettingMs;
    this.nextTickAt = null;
    this.broadcast(this.snapshot(at, false));
  }

  private startRunning(at: number): void {
    // Bets whose debit has not settled yet cannot enter the round.
    for (const [playerId, pending] of this.pendingDebits) {
      pending.aborted = true;
      const r = this.core.cancelBet(playerId);
      if (r.ok) this.dirty.add(r.player.tile);
      this.audits.delete(playerId);
    }
    // CHANGES_4 §3: lock threshold from the bets on the board; it also caps moves for the rest of the round.
    const { tileCapPct, tileYellowPct, tileCapacity } = this.config;
    if (tileCapPct > 0) {
      this.caps = tileCapsFor(this.core.players.size, tileCapPct, tileYellowPct, false);
      this.core.limits.tileCapacity = Math.min(this.caps.tileCap, hardTileCap(tileCapacity));
    } else {
      const cap = hardTileCap(tileCapacity);
      this.caps = { playerBase: this.core.players.size, tileCap: cap, yellowFrom: Math.ceil(cap / 2), live: false };
    }
    this.core.startRunning();
    this.runningAt = at;
    this.phaseEndsAt = null;
    if (this.core.onBoard === 0) this.enterFast(1, 1);
    this.nextTickAt = at + this.interval();
    this.broadcast(this.snapshot(at, false));
    for (const p of this.core.players.values()) this.sendYou(p.id);
  }

  private enterFast(stage: Stage, k: number): void {
    if (this.fast) return;
    this.fast = true;
    this.fastFrom = { stage, k };
  }

  private doTick(at: number): void {
    const core = this.core;
    const r = core.tick();
    this.ticks.push([r.stage, r.k, r.tile, at]);
    this.dirty.add(r.tile);
    // Players force-cashed at the cap or paid as stage-3 survivors left their tiles on this tick too.
    for (const p of r.forced) this.dirty.add(p.tile);
    for (const p of r.survivors) this.dirty.add(p.tile);
    this.broadcast({
      t: 'tick',
      seq: 0,
      roundId: this.roundId,
      stage: r.stage,
      tileGone: r.tile,
      removedCount: r.k,
      multiplier: r.multiplier100 / 100,
      nextMultiplier: nextOrNull(core.nextMultiplier100),
      countsDelta: this.takeDelta(),
      fast: this.fast,
      serverTime: at,
      checksum: countsChecksum(core.counts),
    });
    for (const p of r.losers) this.resolveAudit(p, at);
    for (const p of r.losers) this.sendYou(p.id);
    for (const p of [...r.forced, ...r.survivors]) this.paid(p, at);
    if (r.losers.length || r.forced.length) this.feedDirty = true;

    if (r.stageComplete) {
      if (r.stage === 3 || this.fast || core.onBoard === 0) {
        if (core.phase !== 'ended') core.end();
        this.endRound(at);
      } else {
        this.phaseEndsAt = at + this.config.intermissionMs;
        this.nextTickAt = null;
        this.broadcast({
          t: 'stageEnd',
          seq: 0,
          roundId: this.roundId,
          stage: r.stage,
          multiplier: r.multiplier100 / 100,
          nextMultiplier: nextOrNull(core.nextMultiplier100),
          phaseEndsAt: this.phaseEndsAt,
          serverTime: at,
        });
      }
      return;
    }
    if (!this.fast && core.onBoard === 0) this.enterFast(r.stage, r.k + 1);
    this.nextTickAt = at + this.interval();
  }

  private startNextStage(at: number): void {
    this.core.startNextStage();
    this.phaseEndsAt = null;
    this.nextTickAt = at + this.interval();
    this.dirty.clear();
    this.broadcast(this.snapshot(at, false));
  }

  private endRound(at: number): void {
    const core = this.core;
    this.phaseEndsAt = at + this.config.resultsMs;
    this.nextTickAt = null;
    const jackpot = jackpotTile(this.permutations[2]);
    const sequences = this.permutations.map((p, i) => p.slice(0, STAGE_REMOVALS[i]));
    const survivors = [...core.players.values()].filter((p) => p.outcome === 'survived');
    const highlights = roundHighlights(core.players.values());
    this.broadcast({
      t: 'roundEnd',
      seq: 0,
      roomId: this.id,
      roundId: this.roundId,
      serverSeed: this.serverSeed,
      serverSeedHash: this.serverSeedHash,
      clientSeed: this.clientSeed,
      sequences,
      played: core.played.map((s) => [...s]),
      jackpotTile: jackpot,
      emptiedAtStage: core.emptiedAtStage,
      survivorsPaid: survivors.map((p) => ({ nickname: maskName(this.nick(p.id)), amount: p.payout })),
      highlights,
      phaseEndsAt: this.phaseEndsAt,
      serverTime: at,
    });
    this.flushFeed(true);

    let staked = 0;
    let paid = 0;
    for (const a of this.audits.values()) {
      staked += a.bet;
      paid += a.payout;
    }
    this.deps.audit.writeRound({
      roundId: this.roundId,
      roomId: this.id,
      currency: this.currency,
      createdAt: this.createdAt,
      runningAt: this.runningAt,
      endedAt: at,
      serverSeedHash: this.serverSeedHash,
      clientSeed: this.clientSeed,
      serverSeed: this.serverSeed,
      sequences,
      played: core.played.map((s) => [...s]),
      jackpotTile: jackpot,
      emptiedAtStage: core.emptiedAtStage,
      fastFrom: this.fastFrom,
      ticks: this.ticks,
      players: [...this.audits.values()],
      totals: { bets: this.audits.size, staked, paid },
    });
    this.history.unshift({
      roundId: this.roundId,
      jackpotTile: jackpot,
      emptiedAtStage: core.emptiedAtStage,
      survivors: survivors.length,
      players: this.audits.size,
      endedAt: at,
      highlights,
    });
    this.history.length = Math.min(this.history.length, 50);
    this.emptyRounds = this.members.size === 0 ? this.emptyRounds + 1 : 0;
    this.deps.onRoundEnd?.(this);
  }

  // ------------------------------------------------------------------ actions

  async bet(playerId: string, amount: number, tileId: number): Promise<Reply<{ amount: number; tileId: number }>> {
    const { clock, wallet } = this.deps;
    const now = clock.now();
    this.advance(now);
    if (!this.members.has(playerId)) return this.reject(playerId, 'bet', 'PHASE');
    if (this.pendingDebits.has(playerId)) return this.reject(playerId, 'bet', 'PHASE');
    const r = this.core.placeBet(playerId, amount, tileId);
    if (!r.ok) return this.reject(playerId, 'bet', r.reason);
    // Seat is reserved now (first come, first served); the debit must succeed before the bet counts.
    const roundId = this.roundId;
    const n = (this.betSeq.get(playerId) ?? 0) + 1;
    this.betSeq.set(playerId, n);
    const txId = `${roundId}:${playerId}:bet:${n}`;
    const pending = { aborted: false };
    this.pendingDebits.set(playerId, pending);
    this.audits.set(playerId, this.newAudit(playerId, amount, tileId, now));
    this.dirty.add(tileId);
    let res;
    try {
      res = await wallet.debit(playerId, amount, txId, roundId);
    } catch {
      res = { ok: false as const, error: 'UNAVAILABLE' as const };
    }
    this.pendingDebits.delete(playerId);
    if (pending.aborted || roundId !== this.roundId) {
      if (res.ok) await wallet.rollback(txId);
      return this.reject(playerId, 'bet', 'PHASE');
    }
    if (!res.ok) {
      const p = this.core.players.get(playerId);
      if (p) this.dirty.add(p.tile);
      this.core.cancelBet(playerId);
      this.audits.delete(playerId);
      return this.reject(playerId, 'bet', res.error === 'INSUFFICIENT_FUNDS' ? 'INSUFFICIENT_FUNDS' : 'WALLET_ERROR');
    }
    this.feedDirty = true;
    this.sendYou(playerId);
    return { ok: true, amount, tileId };
  }

  async cancelBet(playerId: string): Promise<Reply> {
    const { clock, wallet } = this.deps;
    this.advance(clock.now());
    if (this.pendingDebits.has(playerId)) return this.reject(playerId, 'cancelBet', 'PHASE');
    const r = this.core.cancelBet(playerId);
    if (!r.ok) return this.reject(playerId, 'cancelBet', r.reason);
    this.dirty.add(r.player.tile);
    this.audits.delete(playerId);
    this.feedDirty = true;
    const n = this.betSeq.get(playerId) ?? 1;
    await wallet.rollback(`${this.roundId}:${playerId}:bet:${n}`);
    this.sendYou(playerId);
    return { ok: true };
  }

  move(playerId: string, tileId: number): Reply<{ tileId: number }> {
    const now = this.deps.clock.now();
    this.advance(now);
    if (this.core.phase === 'running' && this.nextTickAt !== null && this.nextTickAt - now < this.config.moveLockMs) {
      return this.reject(playerId, 'move', 'MOVE_LOCKED');
    }
    const r = this.core.move(playerId, tileId);
    if (!r.ok) return this.reject(playerId, 'move', r.reason);
    if (r.from !== tileId) {
      this.dirty.add(r.from);
      this.dirty.add(tileId);
      this.feedDirty = true; // the public players list shows tiles
      const a = this.audits.get(playerId);
      if (a) {
        if (this.core.phase === 'betting') a.betTile = tileId;
        a.moves.push([now, r.from, tileId]);
      }
    }
    return { ok: true, tileId };
  }

  cashout(playerId: string): Reply<{ amount: number; multiplier: number; maxWin: boolean }> {
    const now = this.deps.clock.now();
    this.advance(now);
    const r = this.core.cashout(playerId);
    if (!r.ok) return this.reject(playerId, 'cashout', r.reason);
    const p = r.player;
    this.dirty.add(p.tile);
    this.paid(p, now);
    this.afterBoardChange(now);
    return { ok: true, amount: p.payout, multiplier: p.multiplier100! / 100, maxWin: p.outcome === 'maxWin' };
  }

  /** After a cashout empties the board: fast-finish the stage, or end at once in intermission. */
  private afterBoardChange(now: number): void {
    const core = this.core;
    if (core.onBoard > 0) return;
    if (core.phase === 'running' && !this.fast) {
      this.enterFast(core.stage, core.removed + 1);
      if (this.nextTickAt !== null) this.nextTickAt = Math.min(this.nextTickAt, now + this.config.fastTickMs);
      this.schedule();
    } else if (core.phase === 'intermission') {
      core.end();
      this.endRound(now);
      this.schedule();
    }
  }

  // ------------------------------------------------------------------ payouts & messages

  private paid(p: RoundPlayer, at: number): void {
    this.resolveAudit(p, at);
    this.feedDirty = true;
    // Public lists only ever carry masked names ("Sw***7").
    this.topCashouts.push({ nickname: maskName(this.nick(p.id)), amount: p.payout, multiplier: p.multiplier100! / 100 });
    this.topCashouts.sort((a, b) => b.amount - a.amount);
    if (this.topCashouts.length > 20) this.topCashouts.length = 20;
    const kind = p.outcome === 'survived' ? 'jackpot' : 'win';
    void this.creditWithRetry(p.id, p.payout, `${this.roundId}:${p.id}:${kind}`, this.roundId).then(() => this.sendYou(p.id));
  }

  private async creditWithRetry(playerId: string, amount: number, txId: string, roundId: string, attempt = 0): Promise<void> {
    if (amount <= 0) return;
    let ok = false;
    try {
      ok = (await this.deps.wallet.credit(playerId, amount, txId, roundId)).ok;
    } catch {
      ok = false;
    }
    if (ok) return;
    this.deps.audit.event('credit_failed', { playerId, amount, txId, roundId, attempt });
    if (attempt >= CREDIT_RETRY_MS.length) {
      this.deps.audit.event('credit_abandoned', { playerId, amount, txId, roundId });
      return;
    }
    await new Promise<void>((res) => this.deps.clock.setTimeout(res, CREDIT_RETRY_MS[attempt]));
    return this.creditWithRetry(playerId, amount, txId, roundId, attempt + 1);
  }

  private resolveAudit(p: RoundPlayer, at: number): void {
    const a = this.audits.get(p.id);
    if (!a) return;
    a.outcome = p.outcome;
    a.stage = p.resolvedStage;
    a.k = p.resolvedK;
    a.multiplier = p.multiplier100 === null ? null : p.multiplier100 / 100;
    a.payout = p.payout;
    a.resolvedAt = at;
  }

  private newAudit(playerId: string, bet: number, tile: number, at: number): PlayerAudit {
    return {
      playerId,
      nickname: this.nick(playerId),
      bet,
      betTile: tile,
      betAt: at,
      moves: [],
      outcome: null,
      stage: null,
      k: null,
      multiplier: null,
      payout: 0,
      resolvedAt: null,
    };
  }

  private nick(playerId: string): string {
    return this.members.get(playerId)?.nickname ?? this.audits.get(playerId)?.nickname ?? playerId;
  }

  private reject<T>(playerId: string, action: string, code: ErrorCode): Reply<T> {
    this.deps.audit.rejected({ at: this.deps.clock.now(), roomId: this.id, playerId, action, code });
    return { ok: false, reason: code };
  }

  /** The player's view of their own bet. */
  youFor(playerId: string, balance: number): YouMsg {
    const p = this.core.players.get(playerId);
    const m100 = this.core.multiplier100;
    return {
      t: 'you',
      roundId: this.roundId,
      state: p?.state ?? 'idle',
      tileId: p?.tile ?? null,
      bet: p?.bet ?? 0,
      potentialWin: p && p.state === 'alive' ? payout(p.bet, m100, this.config.maxWinPerBet) : 0,
      payout: p?.payout ?? 0,
      multiplier: p?.multiplier100 != null ? p.multiplier100 / 100 : null,
      maxWin: p?.outcome === 'maxWin',
      balance,
    };
  }

  private sendYou(playerId: string): void {
    void this.deps.wallet.getBalance(playerId, this.currency).then((bal) => this.deps.sink.sendToPlayer(playerId, this.youFor(playerId, bal)));
  }

  private takeDelta(): CountsDelta {
    const out: CountsDelta = [];
    for (const t of this.dirty) out.push(t, this.core.counts[t]);
    this.dirty.clear();
    return out;
  }

  flushOccupancy(): void {
    if (this.closed || this.dirty.size === 0) return;
    this.broadcast({ t: 'occupancy', seq: 0, countsDelta: this.takeDelta() });
  }

  liveFeed(): LiveFeedMsg {
    let alive = 0;
    let cashedOut = 0;
    let lost = 0;
    let staked = 0;
    let paid = 0;
    let biggestWin = 0;
    let biggestMultiplier = 0;
    const cashed: RoundPlayer[] = [];
    const live: RoundPlayer[] = [];
    const gone: RoundPlayer[] = [];
    for (const p of this.core.players.values()) {
      staked += p.bet;
      if (p.state === 'alive' || p.state === 'betting') {
        alive++;
        live.push(p);
      } else if (p.state === 'cashedOut') {
        cashedOut++;
        cashed.push(p);
        paid += p.payout;
        if (p.payout > biggestWin) {
          biggestWin = p.payout;
          biggestMultiplier = p.multiplier100! / 100;
        }
      } else if (p.state === 'lost') {
        lost++;
        gone.push(p);
      }
    }
    // Public list: at most LIST_LIMIT rows, masked names (BUILD_SPEC §8: never list every bet).
    const listed: RoundPlayer[] = [];
    for (const [group, key] of [
      [cashed, (p: RoundPlayer) => p.payout],
      [live, (p: RoundPlayer) => p.bet],
      [gone, (p: RoundPlayer) => p.bet],
    ] as const) {
      if (listed.length >= LIST_LIMIT) break;
      listed.push(...topBy(group, key, LIST_LIMIT - listed.length));
    }
    return {
      t: 'liveFeed',
      seq: 0,
      roundId: this.roundId,
      topCashouts: this.topCashouts.slice(0, 20),
      totals: { players: this.core.players.size, alive, cashedOut, lost },
      stats: { inRoom: this.members.size, staked, paid, biggestWin, biggestMultiplier },
      bets: listed.map((p) => ({
        nickname: maskName(this.nick(p.id)),
        bet: p.bet,
        tile: p.tile,
        state: p.state,
        multiplier: p.multiplier100 === null ? null : p.multiplier100 / 100,
        payout: p.payout,
      })),
      moreBets: this.core.players.size - listed.length,
    };
  }

  private flushFeed(force = false): void {
    if (this.closed || (!this.feedDirty && !force)) return;
    this.feedDirty = false;
    this.broadcast(this.liveFeed());
  }

  snapshot(now = this.deps.clock.now(), current = true): RoundStateMsg {
    const core = this.core;
    return {
      t: 'roundState',
      seq: current ? this.seq : 0,
      roomId: this.id,
      roundId: this.roundId,
      phase: core.phase,
      stage: core.stage,
      removedCount: core.removed,
      multiplier: core.multiplier100 / 100,
      nextMultiplier: nextOrNull(core.nextMultiplier100),
      tiles: Array.from(core.counts),
      goneMask: encodeGoneMask(core.gone),
      played: core.played.map((s) => [...s]),
      serverSeedHash: this.serverSeedHash,
      clientSeed: this.clientSeed,
      phaseEndsAt: this.core.phase === 'running' ? this.nextTickAt : this.phaseEndsAt,
      serverTime: now,
      fast: this.fast,
      caps: this.tileCaps,
    };
  }

  private broadcast(msg: BroadcastMessage): void {
    msg.seq = ++this.seq;
    // A snapshot inside a broadcast resets the client's counts, so pending deltas are folded in.
    if (msg.t === 'roundState') this.dirty.clear();
    this.deps.sink.broadcast(this.id, msg);
  }
}

function nextOrNull(m100: number | null): number | null {
  return m100 === null ? null : m100 / 100;
}
