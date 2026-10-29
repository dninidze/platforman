import type { GameConfig, Stage, TileCaps } from './constants';

export type ErrorCode =
  | 'TILE_FULL'
  | 'TILE_GONE'
  | 'MOVE_LOCKED'
  | 'TOO_LATE'
  | 'BET_LIMIT'
  | 'INSUFFICIENT_FUNDS'
  | 'PHASE'
  // Additions beyond the spec's list (see README):
  | 'RATE_LIMIT'
  | 'BAD_REQUEST'
  | 'NOT_JOINED'
  | 'NO_ROOM'
  | 'WALLET_ERROR';

export type Phase = 'betting' | 'running' | 'intermission' | 'ended';
export type PlayerState = 'idle' | 'betting' | 'alive' | 'cashedOut' | 'lost';

/** countsDelta is a flat list: [tileId, count, tileId, count, ...]. */
export type CountsDelta = number[];

// ---------- client -> server ----------
export type ClientMessage =
  /**
   * Identity comes from the session provider (aggregator token or demo identity), never typed by the player.
   * `balance`: an opening balance (aggregator) or the page's persisted play-money balance (demo).
   */
  | { t: 'join'; playerId: string; displayName: string; currency?: string; balance?: number; rid?: number }
  | { t: 'spectate'; roomId: string; rid?: number }
  | { t: 'bet'; amount: number; tileId: number; rid?: number }
  | { t: 'cancelBet'; rid?: number }
  | { t: 'move'; tileId: number; rid?: number }
  | { t: 'cashout'; rid?: number }
  | { t: 'resync' }
  | { t: 'ping'; at: number }
  // Local-host extensions (in-page engine): settings, wallet reset, logs.
  | { t: 'settings'; bots?: number; busyServer?: boolean; roomSoftCap?: number }
  | { t: 'resetBalance' }
  | { t: 'getHistory' }
  | { t: 'getRound'; roundId: string }
  | { t: 'getLog' };

// ---------- server -> client ----------
export interface PublicConfig extends Pick<
  GameConfig,
  | 'tickMs'
  | 'fastTickMs'
  | 'bettingMs'
  | 'intermissionMs'
  | 'resultsMs'
  | 'moveLockMs'
  | 'tileCapacity'
  | 'tileCapPct'
  | 'tileYellowPct'
  | 'minBet'
  | 'maxBet'
  | 'maxWinPerBet'
  | 'currency'
> {}

export interface RoomInfo {
  roomId: string;
  currency: string;
  players: number;
}

export interface WelcomeMsg {
  t: 'welcome';
  playerId: string;
  displayName: string;
  roomId: string;
  balance: number;
  config: PublicConfig;
  rooms: RoomInfo[];
}

export interface RoundStateMsg {
  t: 'roundState';
  seq: number;
  roomId: string;
  roundId: string;
  phase: Phase;
  stage: Stage;
  removedCount: number;
  multiplier: number;
  nextMultiplier: number | null;
  /** 100 occupancy counts, row-major. */
  tiles: number[];
  /** 25 hex chars, bit i set = tile i Gone this stage. */
  goneMask: string;
  /** Tiles removed so far this round, per stage (public history only, never future tiles). */
  played: number[][];
  serverSeedHash: string;
  clientSeed: string;
  phaseEndsAt: number | null;
  serverTime: number;
  fast: boolean;
  /** Tile thresholds (CHANGES_4 §3): live during betting, frozen from the round start. */
  caps: TileCaps;
}

export interface TickMsg {
  t: 'tick';
  seq: number;
  roundId: string;
  stage: Stage;
  tileGone: number;
  removedCount: number;
  multiplier: number;
  nextMultiplier: number | null;
  countsDelta: CountsDelta;
  fast: boolean;
  serverTime: number;
  /** countsChecksum() of all 100 counts after this tick; lets the client prove it is in sync. */
  checksum: number;
}

export interface OccupancyMsg {
  t: 'occupancy';
  seq: number;
  countsDelta: CountsDelta;
}

export interface StageEndMsg {
  t: 'stageEnd';
  seq: number;
  roundId: string;
  stage: Stage;
  multiplier: number;
  /** First multiplier of the next stage. */
  nextMultiplier: number | null;
  phaseEndsAt: number | null;
  serverTime: number;
}

export interface SurvivorPaid {
  nickname: string;
  amount: number;
}

export interface RoundEndMsg {
  t: 'roundEnd';
  seq: number;
  roomId: string;
  roundId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  sequences: number[][];
  played: number[][];
  jackpotTile: number;
  /** Stage in which the round emptied, or null if the round ran to the end of stage 3. */
  emptiedAtStage: Stage | null;
  survivorsPaid: SurvivorPaid[];
  phaseEndsAt: number | null;
  serverTime: number;
}

export interface YouMsg {
  t: 'you';
  roundId: string;
  state: PlayerState;
  tileId: number | null;
  bet: number;
  potentialWin: number;
  payout: number;
  multiplier: number | null;
  maxWin: boolean;
  balance: number;
}

export interface CashoutResultMsg {
  t: 'cashoutResult';
  rid?: number;
  ok: boolean;
  amount?: number;
  multiplier?: number;
  maxWin?: boolean;
  reason?: ErrorCode;
}
export interface MoveResultMsg {
  t: 'moveResult';
  rid?: number;
  ok: boolean;
  tileId?: number;
  reason?: ErrorCode;
}
export interface BetResultMsg {
  t: 'betResult';
  rid?: number;
  ok: boolean;
  amount?: number;
  tileId?: number;
  reason?: ErrorCode;
}
export interface CancelResultMsg {
  t: 'cancelResult';
  rid?: number;
  ok: boolean;
  reason?: ErrorCode;
}

export interface LiveFeedMsg {
  t: 'liveFeed';
  seq: number;
  roundId: string;
  topCashouts: { nickname: string; amount: number; multiplier: number }[];
  totals: { players: number; alive: number; cashedOut: number; lost: number };
  /** Room members (bettors or not) and money totals for the round, minor units. */
  stats: { inRoom: number; staked: number; paid: number; biggestWin: number; biggestMultiplier: number };
  /** Up to 50 participating players (masked names): cash-outs by amount, then live bets by size, then losses. */
  bets: PublicBet[];
  /** Bets not listed in `bets`. */
  moreBets: number;
}

export interface PublicBet {
  nickname: string;
  bet: number;
  tile: number;
  state: PlayerState;
  multiplier: number | null;
  payout: number;
}

export interface RoomsMsg {
  t: 'rooms';
  rooms: RoomInfo[];
  home: string | null;
  watching: string | null;
}

export interface ErrorMsg {
  t: 'error';
  code: ErrorCode;
  message: string;
  rid?: number;
}

export interface PongMsg {
  t: 'pong';
  at: number;
  serverTime: number;
}

/** Room-wide broadcasts carry a per-room `seq`; a gap means the client should send `resync`. */
export type BroadcastMessage = RoundStateMsg | TickMsg | OccupancyMsg | StageEndMsg | RoundEndMsg | LiveFeedMsg;

export interface HistoryEntryMsg {
  roundId: string;
  jackpotTile: number;
  emptiedAtStage: Stage | null;
  survivors: number;
  players: number;
  endedAt: number;
}

export interface HistoryMsg {
  t: 'history';
  roomId: string;
  rounds: HistoryEntryMsg[];
}

/** A logged round as the audit log holds it (see engine RoundRecord). */
export interface RoundRecordMsg {
  t: 'roundRecord';
  roundId: string;
  record: (Record<string, unknown> & { serverSeed: string; serverSeedHash: string; clientSeed: string; sequences: number[][]; played: number[][] }) | null;
}

export interface LogMsg {
  t: 'log';
  jsonl: string;
  rounds: number;
}

export interface BalanceMsg {
  t: 'balance';
  balance: number;
}

export interface HostSettings {
  bots: number;
  busyServer: boolean;
  roomSoftCap: number;
}

export interface SettingsMsg extends HostSettings {
  t: 'settings';
}

export interface HostStatsMsg {
  t: 'hostStats';
  at: number;
  bots: number;
  rooms: RoomInfo[];
  /** Tick fire time minus scheduled time, over the last stats window (ms). */
  tickLateness: { n: number; p50: number; p95: number; max: number; min: number };
  /** Share of wall time the engine spent inside timer callbacks (0..1). */
  engineBusy: number;
  messagesToClient: number;
  actions: number;
  rejects: Record<string, number>;
}

export type ServerMessage =
  | WelcomeMsg
  | HistoryMsg
  | RoundRecordMsg
  | LogMsg
  | BalanceMsg
  | SettingsMsg
  | HostStatsMsg
  | BroadcastMessage
  | YouMsg
  | CashoutResultMsg
  | MoveResultMsg
  | BetResultMsg
  | CancelResultMsg
  | RoomsMsg
  | ErrorMsg
  | PongMsg;

/** Encode the gone mask as 25 hex chars (4 tiles per char). */
export function encodeGoneMask(gone: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < gone.length; i += 4) {
    let nib = 0;
    for (let b = 0; b < 4; b++) if (gone[i + b]) nib |= 1 << b;
    out += nib.toString(16);
  }
  return out;
}

export function decodeGoneMask(mask: string, n = 100): boolean[] {
  const out = new Array<boolean>(n).fill(false);
  for (let c = 0; c < mask.length; c++) {
    const nib = parseInt(mask[c], 16);
    for (let b = 0; b < 4; b++) if (c * 4 + b < n) out[c * 4 + b] = (nib & (1 << b)) !== 0;
  }
  return out;
}

/** Order-sensitive checksum of the 100 tile counts (used to prove UI/engine sync). */
export function countsChecksum(counts: ArrayLike<number>): number {
  let h = 0;
  for (let i = 0; i < counts.length; i++) h = (Math.imul(h, 31) + counts[i] * (i + 1)) | 0;
  return h >>> 0;
}
