import {
  RealClock,
  TILE_COUNT,
  type BroadcastMessage,
  type ClientMessage,
  type Clock,
  type ErrorCode,
  type GameConfig,
  type HostSettings,
  type HostStatsMsg,
  type ServerMessage,
  type TimerHandle,
} from '@p3/shared';
import { MemoryAuditLog } from './audit';
import { BotDriver } from './bots';
import { makeConfig, publicConfig } from './config';
import type { Room } from './room';
import { RoomManager } from './roomManager';
import { MockWallet } from './wallet';

/**
 * The "local server": owns rooms, wallet, bots and audit log, and speaks the §8 protocol to any number
 * of connections through plain message objects. In the page it runs inside a Web Worker; a WebSocket
 * gateway could wrap the same host later without changing the client.
 */

const PLAYER_ID_RE = /^[A-Za-z0-9:_.@-]{1,64}$/;
/** "Simulate busy server" off: one room for everyone (tile capacity still caps seated players at 9,900). */
const SINGLE_ROOM_CAP = Number.MAX_SAFE_INTEGER;

class Bucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Real clock that also measures how long timer callbacks take (engine busy share). */
export class InstrumentedClock extends RealClock {
  busyMs = 0;
  private wrap(fn: () => void): () => void {
    return () => {
      const t = performance.now();
      try {
        fn();
      } finally {
        this.busyMs += performance.now() - t;
      }
    };
  }
  override setTimeout(fn: () => void, ms: number): TimerHandle {
    return super.setTimeout(this.wrap(fn), ms);
  }
  override setInterval(fn: () => void, ms: number): TimerHandle {
    return super.setInterval(this.wrap(fn), ms);
  }
}

interface Conn {
  send: (msg: ServerMessage) => void;
  playerId: string | null;
  watching: string | null;
  moves: Bucket;
  msgs: Bucket;
}

export interface HostEndpoint {
  receive(msg: ClientMessage): void;
  close(): void;
}

export interface HostOptions {
  clock?: Clock;
  config?: Partial<GameConfig>;
  settings?: Partial<HostSettings>;
  rng?: () => number;
  seedSource?: () => string;
  /** Stats push interval (ms); 0 disables. */
  statsMs?: number;
}

export class LocalHost {
  readonly clock: Clock;
  readonly config: GameConfig;
  readonly wallet: MockWallet;
  readonly audit = new MemoryAuditLog(300, 500);
  readonly manager: RoomManager;
  readonly bots: BotDriver;
  readonly settings: HostSettings;
  private readonly conns = new Set<Conn>();
  private readonly players = new Map<string, Conn>();
  private lateness: number[] = [];
  private messagesToClient = 0;
  private actions = 0;
  private statsTimer: TimerHandle | null = null;
  private lastStatsAt: number;
  private lastBusy = 0;

  constructor(opts: HostOptions = {}) {
    this.clock = opts.clock ?? new InstrumentedClock();
    this.settings = { bots: 300, busyServer: false, roomSoftCap: 2_000, ...opts.settings };
    this.config = makeConfig({ ...opts.config, roomSoftCap: this.softCap() });
    this.wallet = new MockWallet(this.config.startingBalance, this.config.currency);
    this.manager = new RoomManager({
      config: this.config,
      clock: this.clock,
      wallet: this.wallet,
      audit: this.audit,
      seedSource: opts.seedSource,
      sink: {
        broadcast: (roomId, msg) => this.broadcast(roomId, msg),
        sendToPlayer: (playerId, msg) => {
          const c = this.players.get(playerId);
          if (c) this.send(c, msg);
        },
      },
      onRoomClosed: (room) => {
        for (const c of this.conns) {
          if (c.watching !== room.id) continue;
          c.watching = null;
          const home = c.playerId ? this.manager.roomOf(c.playerId) : undefined;
          if (home) this.watch(c, home);
        }
      },
    });
    this.bots = new BotDriver({ manager: this.manager, clock: this.clock, config: this.config, rng: opts.rng });
    this.bots.setCount(this.settings.bots);
    this.lastStatsAt = this.clock.now();
    const statsMs = opts.statsMs ?? 1_000;
    if (statsMs > 0) this.statsTimer = this.clock.setInterval(() => this.pushStats(), statsMs);
  }

  private softCap(): number {
    return this.settings.busyServer ? this.settings.roomSoftCap : SINGLE_ROOM_CAP;
  }

  connect(send: (msg: ServerMessage) => void): HostEndpoint {
    const now = this.clock.now();
    const conn: Conn = {
      send,
      playerId: null,
      watching: null,
      moves: new Bucket(this.config.movesPerSecond, this.config.movesPerSecond, now),
      msgs: new Bucket(30, 60, now),
    };
    this.conns.add(conn);
    this.send(conn, { t: 'settings', ...this.settings });
    return {
      receive: (msg) =>
        void this.handle(conn, msg).catch((e) => {
          this.audit.event('handler_error', { error: String((e as Error)?.stack ?? e) });
          this.send(conn, { t: 'error', code: 'BAD_REQUEST', message: 'internal error' });
        }),
      close: () => {
        this.conns.delete(conn);
        if (conn.playerId && this.players.get(conn.playerId) === conn) {
          this.players.delete(conn.playerId);
          this.manager.leave(conn.playerId);
        }
      },
    };
  }

  shutdown(): void {
    this.clock.clearInterval(this.statsTimer);
    this.manager.shutdown();
  }

  applySettings(p: Partial<HostSettings>): void {
    const before = this.softCap();
    if (p.roomSoftCap !== undefined && Number.isFinite(p.roomSoftCap)) this.settings.roomSoftCap = Math.max(1, Math.floor(p.roomSoftCap));
    if (p.busyServer !== undefined) this.settings.busyServer = !!p.busyServer;
    this.config.roomSoftCap = this.softCap();
    if (this.config.roomSoftCap !== before) this.bots.reseat();
    if (p.bots !== undefined && Number.isFinite(p.bots)) {
      this.bots.setCount(p.bots);
      this.settings.bots = this.bots.count;
    }
    for (const c of this.conns) {
      this.send(c, { t: 'settings', ...this.settings });
      this.send(c, this.roomsMsg(c));
    }
  }

  // ------------------------------------------------------------------ plumbing

  private send(conn: Conn, msg: ServerMessage): void {
    this.messagesToClient++;
    conn.send(msg);
  }

  private broadcast(roomId: string, msg: BroadcastMessage): void {
    if (msg.t === 'tick') this.lateness.push(this.clock.now() - msg.serverTime);
    for (const c of this.conns) if (c.watching === roomId) this.send(c, msg);
    // The first room opens (and broadcasts) inside the RoomManager constructor, before bots exist.
    (this.bots as BotDriver | undefined)?.onBroadcast(roomId, msg);
  }

  private roomsMsg(conn: Conn): ServerMessage {
    return {
      t: 'rooms',
      rooms: this.manager.list(),
      home: conn.playerId ? (this.manager.roomOf(conn.playerId)?.id ?? null) : null,
      watching: conn.watching,
    };
  }

  private watch(conn: Conn, room: Room): void {
    conn.watching = room.id;
    room.advance();
    this.send(conn, room.snapshot());
    this.send(conn, { ...room.liveFeed(), seq: room.seq });
    this.send(conn, this.roomsMsg(conn));
    this.send(conn, { t: 'history', roomId: room.id, rounds: room.history.slice(0, 20) });
  }

  private err(conn: Conn, code: ErrorCode, message: string, rid?: number): void {
    this.audit.rejected({ at: this.clock.now(), roomId: conn.watching, playerId: conn.playerId, action: 'message', code, detail: message });
    this.send(conn, { t: 'error', code, message, rid });
  }

  private pushStats(): void {
    const now = this.clock.now();
    const sorted = this.lateness.sort((a, b) => a - b);
    const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
    const busyMs = this.clock instanceof InstrumentedClock ? this.clock.busyMs : 0;
    const msg: HostStatsMsg = {
      t: 'hostStats',
      at: now,
      bots: this.bots.count,
      rooms: this.manager.list(),
      tickLateness: { n: sorted.length, p50: q(0.5), p95: q(0.95), max: sorted.at(-1) ?? 0, min: sorted[0] ?? 0 },
      engineBusy: (busyMs - this.lastBusy) / Math.max(1, now - this.lastStatsAt),
      messagesToClient: this.messagesToClient,
      actions: this.actions,
      rejects: { ...this.audit.rejectCounts },
    };
    this.lateness = [];
    this.lastBusy = busyMs;
    this.lastStatsAt = now;
    for (const c of this.conns) this.send(c, msg);
  }

  // ------------------------------------------------------------------ protocol

  private async handle(conn: Conn, msg: ClientMessage): Promise<void> {
    const now = this.clock.now();
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.err(conn, 'BAD_REQUEST', 'malformed message');
    if (msg.t === 'ping') return this.send(conn, { t: 'pong', at: msg.at, serverTime: now });
    if (!conn.msgs.take(now)) return this.err(conn, 'RATE_LIMIT', 'too many messages', 'rid' in msg ? msg.rid : undefined);

    switch (msg.t) {
      case 'join': {
        const playerId = String(msg.playerId ?? '');
        const nickname = String(msg.displayName ?? '').trim().slice(0, 32);
        if (!PLAYER_ID_RE.test(playerId) || playerId.startsWith('bot:')) return this.err(conn, 'BAD_REQUEST', 'invalid playerId', msg.rid);
        if (!nickname) return this.err(conn, 'BAD_REQUEST', 'missing displayName', msg.rid);
        if (msg.currency && msg.currency !== this.config.currency) return this.err(conn, 'BAD_REQUEST', `currency ${msg.currency} not offered`, msg.rid);
        if (conn.playerId && conn.playerId !== playerId) return this.err(conn, 'BAD_REQUEST', 'already joined', msg.rid);
        const old = this.players.get(playerId);
        if (old && old !== conn) {
          this.send(old, { t: 'error', code: 'BAD_REQUEST', message: 'This player connected from another tab.' });
          old.playerId = null;
        }
        // A balance persisted by the page seeds the play-money wallet once per host lifetime.
        if (!this.wallet.has(playerId) && Number.isInteger(msg.balance) && msg.balance! >= 0) this.wallet.setBalance(playerId, msg.balance!);
        conn.playerId = playerId;
        this.players.set(playerId, conn);
        const room = this.manager.join(playerId, nickname, this.config.currency);
        const balance = await this.wallet.getBalance(playerId, this.config.currency);
        this.send(conn, { t: 'welcome', playerId, displayName: nickname, roomId: room.id, balance, config: publicConfig(this.config), rooms: this.manager.list() });
        this.watch(conn, room);
        this.send(conn, room.youFor(playerId, balance));
        return;
      }
      case 'spectate': {
        const room = this.manager.get(String(msg.roomId));
        if (!room) return this.err(conn, 'NO_ROOM', 'no such room', msg.rid);
        return this.watch(conn, room);
      }
      case 'resync': {
        const room = conn.watching ? this.manager.get(conn.watching) : undefined;
        if (room) this.send(conn, room.snapshot());
        return;
      }
      case 'settings':
        return this.applySettings(msg);
      case 'getHistory': {
        const room = conn.watching ? this.manager.get(conn.watching) : undefined;
        if (room) this.send(conn, { t: 'history', roomId: room.id, rounds: room.history.slice(0, 20) });
        return;
      }
      case 'getRound': {
        const rec = this.audit.findRound(String(msg.roundId));
        return this.send(conn, { t: 'roundRecord', roundId: String(msg.roundId), record: (rec as never) ?? null });
      }
      case 'getLog':
        return this.send(conn, { t: 'log', jsonl: this.audit.rounds.map((r) => JSON.stringify(r)).join('\n') + '\n', rounds: this.audit.rounds.length });
      case 'resetBalance': {
        if (!conn.playerId) return this.err(conn, 'NOT_JOINED', 'join first');
        this.wallet.setBalance(conn.playerId, this.config.startingBalance);
        return this.send(conn, { t: 'balance', balance: this.config.startingBalance });
      }
    }

    const playerId = conn.playerId;
    const room = playerId ? this.manager.roomOf(playerId) : undefined;
    if (!playerId || !room) return this.err(conn, 'NOT_JOINED', 'join first', 'rid' in msg ? msg.rid : undefined);
    this.actions++;
    switch (msg.t) {
      case 'bet': {
        const r = await room.bet(playerId, Number(msg.amount), Number(msg.tileId));
        return this.send(conn, r.ok ? { t: 'betResult', rid: msg.rid, ok: true, amount: r.amount, tileId: r.tileId } : { t: 'betResult', rid: msg.rid, ok: false, reason: r.reason });
      }
      case 'cancelBet': {
        const r = await room.cancelBet(playerId);
        return this.send(conn, r.ok ? { t: 'cancelResult', rid: msg.rid, ok: true } : { t: 'cancelResult', rid: msg.rid, ok: false, reason: r.reason });
      }
      case 'move': {
        if (!conn.moves.take(now)) {
          this.audit.rejected({ at: now, roomId: room.id, playerId, action: 'move', code: 'RATE_LIMIT' });
          return this.send(conn, { t: 'moveResult', rid: msg.rid, ok: false, reason: 'RATE_LIMIT' });
        }
        const r = room.move(playerId, Number(msg.tileId));
        return this.send(conn, r.ok ? { t: 'moveResult', rid: msg.rid, ok: true, tileId: r.tileId } : { t: 'moveResult', rid: msg.rid, ok: false, reason: r.reason });
      }
      case 'cashout': {
        const r = room.cashout(playerId);
        return this.send(
          conn,
          r.ok
            ? { t: 'cashoutResult', rid: msg.rid, ok: true, amount: r.amount, multiplier: r.multiplier, maxWin: r.maxWin }
            : { t: 'cashoutResult', rid: msg.rid, ok: false, reason: r.reason },
        );
      }
      default:
        return this.err(conn, 'BAD_REQUEST', 'unknown message type');
    }
  }
}
