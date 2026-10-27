import {
  countsChecksum,
  decodeGoneMask,
  type HostSettings,
  type PlayerSession,
  type HostStatsMsg,
  type RoundRecordMsg,
  type ClientMessage,
  type CountsDelta,
  type ErrorCode,
  type LiveFeedMsg,
  type Phase,
  type PublicConfig,
  type RoomInfo,
  type RoundEndMsg,
  type ServerMessage,
  type Stage,
  type YouMsg,
} from '@p3/shared';
import type { Transport } from './transport';

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage blocked: the game still works, the balance just won't persist */
    }
  },
};
export { store };
const balanceKey = (playerId: string) => `lts.balance.${playerId}`;

/**
 * Client-side store. It only mirrors server state: no outcome is ever computed here.
 */

export interface RoundView {
  roomId: string;
  roundId: string;
  phase: Phase;
  stage: Stage;
  removed: number;
  multiplier: number;
  nextMultiplier: number | null;
  counts: number[];
  gone: boolean[];
  played: number[][];
  serverSeedHash: string;
  clientSeed: string;
  phaseEndsAt: number | null;
  fast: boolean;
}

export interface HistoryEntry {
  roundId: string;
  jackpotTile: number;
  emptiedAtStage: Stage | null;
  survivors: number;
}

/** A revealed round plus what this client saw before the reveal. */
export interface Revealed extends RoundEndMsg {
  /** Hash this client was shown while the round was running. */
  hashSeen: string;
  /** Tiles this client saw removed (may start mid-round if it joined late). */
  observed: number[][];
}

export interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info' | 'win';
}

export interface GameState {
  connected: boolean;
  joined: boolean;
  /** Identity from the session provider (aggregator token or demo identity). */
  session: PlayerSession | null;
  homeRoom: string | null;
  watching: string | null;
  config: PublicConfig | null;
  balance: number;
  rooms: RoomInfo[];
  round: RoundView | null;
  you: YouMsg | null;
  feed: LiveFeedMsg | null;
  history: HistoryEntry[];
  /** Revealed rounds seen in this session, newest first (for the fairness modal). */
  revealed: Revealed[];
  lastGone: { tile: number; key: number } | null;
  lostAt: number | null;
  toasts: Toast[];
  /** serverTime - Date.now() */
  offset: number;
  resyncs: number;
  transport: string;
  settings: HostSettings | null;
  hostStats: HostStatsMsg | null;
}

/** UI-side sync and timing metrics (kept off the React state to avoid re-renders). */
export interface ClientMetrics {
  ticks: number;
  rounds: number;
  checksumMismatches: number;
  /** Date.now() at receipt minus the tick's scheduled serverTime, for recent ticks. */
  delivery: number[];
}

const REASON_TEXT: Partial<Record<ErrorCode, string>> = {
  TILE_FULL: 'Tile is full',
  TILE_GONE: 'That tile is Gone',
  MOVE_LOCKED: 'Locked: a tile is about to go',
  TOO_LATE: 'Too late',
  BET_LIMIT: 'Bet outside limits',
  INSUFFICIENT_FUNDS: 'Not enough balance',
  PHASE: 'Not possible right now',
  RATE_LIMIT: 'Slow down',
  NOT_JOINED: 'Join first',
  NO_ROOM: 'Room closed',
  WALLET_ERROR: 'Wallet unavailable',
};

export const reasonText = (r?: ErrorCode) => (r && REASON_TEXT[r]) || r || 'Rejected';

const initial: GameState = {
  connected: false,
  joined: false,
  session: null,
  homeRoom: null,
  watching: null,
  config: null,
  balance: 0,
  rooms: [],
  round: null,
  you: null,
  feed: null,
  history: [],
  revealed: [],
  lastGone: null,
  lostAt: null,
  toasts: [],
  offset: 0,
  resyncs: 0,
  transport: '',
  settings: null,
  hostStats: null,
};

export class GameClient {
  state: GameState = initial;
  private transport: Transport | null = null;
  readonly metrics: ClientMetrics = { ticks: 0, rounds: 0, checksumMismatches: 0, delivery: [] };
  private pending = new Map<string, (m: ServerMessage) => void>();
  private listeners = new Set<() => void>();
  private lastSeq = 0;
  private awaitingSnapshot = false;
  private toastId = 0;
  private rid = 0;
  private session: PlayerSession | null = null;
  private historyFor: string | null = null;
  private closed = false;

  constructor(private readonly makeTransport: () => Transport) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;

  private set(patch: Partial<GameState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Stop for good (used when a dev hot-reload replaces this module). */
  close() {
    this.closed = true;
    this.transport?.close();
  }

  /** Replace the transport (e.g. worker failed: fall back to the main thread) and rejoin. */
  reconnect() {
    this.transport?.close();
    this.lastSeq = 0;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const t = this.makeTransport();
    this.transport = t;
    this.set({ transport: t.kind });
    t.onMessage((m) => this.onMessage(m));
    t.onStatus((up) => {
      this.set({ connected: up });
      if (up && this.session) this.sendJoin(this.session);
    });
  }

  /**
   * Join with the provider's identity. The opening balance is the aggregator's when it sent one, else
   * (demo) the balance this page persisted for this playerId.
   */
  private sendJoin(session: PlayerSession) {
    const raw = store.get(balanceKey(session.playerId));
    const saved = Number(raw);
    const balance = session.balance ?? (raw !== null && Number.isInteger(saved) && saved >= 0 ? saved : undefined);
    this.send({ t: 'join', playerId: session.playerId, displayName: session.displayName, currency: session.currency, ...(balance !== undefined ? { balance } : {}) });
  }

  /** Start playing as `session` (connects the transport if needed). */
  start(session: PlayerSession) {
    this.session = session;
    this.set({ session });
    if (!this.transport) this.connect();
    else if (this.state.connected) this.sendJoin(session);
  }

  updateSettings(p: Partial<HostSettings>) {
    this.send({ t: 'settings', ...p });
  }
  resetBalance() {
    this.send({ t: 'resetBalance' });
  }

  /** Ask the engine for a logged round (fairness modal). */
  getRound(roundId: string): Promise<RoundRecordMsg> {
    return new Promise((resolve) => {
      this.pending.set(`round:${roundId}`, (m) => resolve(m as RoundRecordMsg));
      this.send({ t: 'getRound', roundId });
    });
  }
  /** All logged rounds as JSONL (download button). */
  getLog(): Promise<string> {
    return new Promise((resolve) => {
      this.pending.set('log', (m) => resolve(m.t === 'log' ? m.jsonl : ''));
      this.send({ t: 'getLog' });
    });
  }

  private persistBalance(balance: number) {
    // Demo balances persist in this browser; an aggregator's wallet is the source of truth for real sessions.
    if (this.session?.mode === 'demo') store.set(balanceKey(this.session.playerId), String(balance));
  }

  private send(msg: ClientMessage) {
    this.transport?.send(msg);
  }

  bet(amount: number, tileId: number) {
    this.send({ t: 'bet', amount, tileId, rid: ++this.rid });
  }
  cancelBet() {
    this.send({ t: 'cancelBet', rid: ++this.rid });
  }
  move(tileId: number) {
    this.send({ t: 'move', tileId, rid: ++this.rid });
  }
  cashout() {
    this.send({ t: 'cashout', rid: ++this.rid });
  }
  spectate(roomId: string) {
    this.send({ t: 'spectate', roomId, rid: ++this.rid });
  }

  toast(text: string, kind: Toast['kind'] = 'error') {
    const id = ++this.toastId;
    this.set({ toasts: [...this.state.toasts.slice(-3), { id, text, kind }] });
    setTimeout(() => this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) }), 2_400);
  }

  serverNow() {
    return Date.now() + this.state.offset;
  }

  /** Room broadcasts carry seq; a gap means we missed something, so ask for a full snapshot. */
  private checkSeq(seq: number): boolean {
    if (this.awaitingSnapshot) return false;
    if (seq <= this.lastSeq) return seq === this.lastSeq; // a direct message tagged with the current seq
    if (seq !== this.lastSeq + 1) {
      this.awaitingSnapshot = true;
      this.send({ t: 'resync' });
      this.set({ resyncs: this.state.resyncs + 1 });
      return false;
    }
    this.lastSeq = seq;
    return true;
  }

  private applyDelta(counts: number[], delta: CountsDelta): number[] {
    if (delta.length === 0) return counts;
    const next = counts.slice();
    for (let i = 0; i < delta.length; i += 2) next[delta[i]] = delta[i + 1];
    return next;
  }

  private onMessage(m: ServerMessage) {
    const s = this.state;
    switch (m.t) {
      case 'welcome':
        this.set({
          joined: true,
          homeRoom: m.roomId,
          config: m.config,
          balance: m.balance,
          rooms: m.rooms,
        });
        this.persistBalance(m.balance);
        return;
      case 'rooms':
        this.set({ rooms: m.rooms, homeRoom: m.home, watching: m.watching });
        if (m.watching && m.watching !== this.historyFor) {
          this.historyFor = m.watching;
          this.set({ history: [] });
          this.send({ t: 'getHistory' });
        }
        return;
      case 'roundState': {
        this.lastSeq = m.seq;
        this.awaitingSnapshot = false;
        const newRound = s.round?.roundId !== m.roundId;
        this.set({
          offset: m.serverTime - Date.now(),
          watching: m.roomId,
          round: {
            roomId: m.roomId,
            roundId: m.roundId,
            phase: m.phase,
            stage: m.stage,
            removed: m.removedCount,
            multiplier: m.multiplier,
            nextMultiplier: m.nextMultiplier,
            counts: m.tiles,
            gone: decodeGoneMask(m.goneMask),
            played: m.played,
            serverSeedHash: m.serverSeedHash,
            clientSeed: m.clientSeed,
            phaseEndsAt: m.phaseEndsAt,
            fast: m.fast,
          },
          ...(newRound && m.phase === 'betting' ? { lostAt: null } : {}),
        });
        return;
      }
      case 'tick': {
        if (!this.checkSeq(m.seq) || !s.round) return;
        const r = s.round;
        const gone = r.stage === m.stage ? r.gone.slice() : new Array<boolean>(100).fill(false);
        gone[m.tileGone] = true;
        const played = r.played.map((p, i) => (i === m.stage - 1 ? [...p, m.tileGone] : p));
        const counts = this.applyDelta(r.counts, m.countsDelta);
        this.metrics.ticks++;
        this.metrics.delivery.push(Date.now() - m.serverTime);
        if (this.metrics.delivery.length > 2_000) this.metrics.delivery.splice(0, 1_000);
        if (countsChecksum(counts) !== m.checksum) {
          this.metrics.checksumMismatches++;
          this.awaitingSnapshot = true;
          this.send({ t: 'resync' });
        }
        const mine = s.you && s.you.roundId === m.roundId && s.you.state === 'alive' && s.you.tileId === m.tileGone;
        this.set({
          offset: m.serverTime - Date.now(),
          round: {
            ...r,
            phase: 'running',
            stage: m.stage,
            removed: m.removedCount,
            multiplier: m.multiplier,
            nextMultiplier: m.nextMultiplier,
            counts,
            gone,
            played,
            fast: m.fast,
            phaseEndsAt: null,
          },
          lastGone: { tile: m.tileGone, key: m.seq },
          ...(mine ? { lostAt: Date.now() } : {}),
        });
        return;
      }
      case 'occupancy':
        if (!this.checkSeq(m.seq) || !s.round) return;
        this.set({ round: { ...s.round, counts: this.applyDelta(s.round.counts, m.countsDelta) } });
        return;
      case 'stageEnd':
        if (!this.checkSeq(m.seq) || !s.round) return;
        this.set({
          offset: m.serverTime - Date.now(),
          round: {
            ...s.round,
            phase: 'intermission',
            phaseEndsAt: m.phaseEndsAt,
            nextMultiplier: m.nextMultiplier,
            gone: new Array<boolean>(100).fill(false),
          },
        });
        return;
      case 'roundEnd': {
        if (!this.checkSeq(m.seq) || !s.round) return;
        this.metrics.rounds++;
        const entry: HistoryEntry = {
          roundId: m.roundId,
          jackpotTile: m.jackpotTile,
          emptiedAtStage: m.emptiedAtStage,
          survivors: m.survivorsPaid.length,
        };
        this.set({
          offset: m.serverTime - Date.now(),
          round: { ...s.round, phase: 'ended', phaseEndsAt: m.phaseEndsAt, played: m.played },
          history: [entry, ...s.history.filter((h) => h.roundId !== m.roundId)].slice(0, 20),
          revealed: [{ ...m, hashSeen: s.round.serverSeedHash, observed: s.round.played }, ...s.revealed].slice(0, 30),
        });
        return;
      }
      case 'liveFeed':
        if (!this.checkSeq(m.seq)) return;
        this.set({ feed: m });
        return;
      case 'you': {
        const prev = s.you;
        this.set({ you: m, balance: m.balance });
        this.persistBalance(m.balance);
        if (m.maxWin && prev?.state !== 'cashedOut') this.toast('Max win reached', 'win');
        if (m.state === 'cashedOut' && prev?.state === 'alive' && !m.maxWin && m.multiplier && m.multiplier >= 10_000) {
          this.toast('10,000x!', 'win');
        }
        return;
      }
      case 'betResult':
        if (!m.ok) this.toast(reasonText(m.reason));
        return;
      case 'cancelResult':
        if (!m.ok) this.toast(reasonText(m.reason));
        return;
      case 'moveResult':
        if (!m.ok) this.toast(reasonText(m.reason));
        // The server confirmed the move; reflect the new tile without waiting for another 'you'.
        else if (s.you && m.tileId !== undefined) this.set({ you: { ...s.you, tileId: m.tileId } });
        return;
      case 'cashoutResult':
        if (!m.ok) this.toast(reasonText(m.reason));
        else this.toast(`Cashed out ${m.multiplier?.toFixed(2)}x`, 'win');
        return;
      case 'error':
        this.toast(m.message || reasonText(m.code));
        return;
      case 'pong':
        return;
      case 'history':
        if (m.roomId === s.watching) this.set({ history: m.rounds.slice(0, 20) });
        return;
      case 'roundRecord':
        this.pending.get(`round:${m.roundId}`)?.(m);
        this.pending.delete(`round:${m.roundId}`);
        return;
      case 'log':
        this.pending.get('log')?.(m);
        this.pending.delete('log');
        return;
      case 'balance':
        this.set({ balance: m.balance, you: s.you ? { ...s.you, balance: m.balance } : s.you });
        this.persistBalance(m.balance);
        this.toast('Balance reset', 'info');
        return;
      case 'settings':
        this.set({ settings: { bots: m.bots, busyServer: m.busyServer, roomSoftCap: m.roomSoftCap } });
        return;
      case 'hostStats':
        this.set({ hostStats: m, rooms: m.rooms });
        return;
    }
  }
}
