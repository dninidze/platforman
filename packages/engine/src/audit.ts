import type { ErrorCode, Stage } from '@p3/shared';

export interface PlayerAudit {
  playerId: string;
  nickname: string;
  bet: number;
  betTile: number;
  betAt: number;
  /** [at, from, to] */
  moves: [number, number, number][];
  outcome: 'cashout' | 'maxWin' | 'survived' | 'lost' | null;
  stage: Stage | null;
  k: number | null;
  multiplier: number | null;
  payout: number;
  resolvedAt: number | null;
}

export interface RoundRecord {
  roundId: string;
  roomId: string;
  currency: string;
  createdAt: number;
  runningAt: number | null;
  endedAt: number;
  serverSeedHash: string;
  clientSeed: string;
  serverSeed: string;
  sequences: number[][];
  played: number[][];
  jackpotTile: number;
  emptiedAtStage: Stage | null;
  /** First tick (stage, k) played in fast mode, if any. */
  fastFrom: { stage: Stage; k: number } | null;
  /** [stage, k, tile, at] for every tick. */
  ticks: [number, number, number, number][];
  players: PlayerAudit[];
  totals: { bets: number; staked: number; paid: number };
}

export interface RejectRecord {
  at: number;
  roomId: string | null;
  playerId: string | null;
  action: string;
  code: ErrorCode;
  detail?: string;
}

export interface AuditLog {
  writeRound(rec: RoundRecord): void;
  rejected(rec: RejectRecord): void;
  event(kind: string, data: Record<string, unknown>): void;
}

/**
 * In-memory audit log. Keeps the most recent `keepRounds` round records (the in-page host offers
 * them as a JSONL download and to the fairness verifier), the last 1,000 events, per-code reject
 * counts and the last `keepRejects` rejections.
 */
export class MemoryAuditLog implements AuditLog {
  readonly rounds: RoundRecord[] = [];
  readonly rejections: RejectRecord[] = [];
  readonly events: { kind: string; data: Record<string, unknown> }[] = [];
  readonly rejectCounts: Record<string, number> = {};
  roundsWritten = 0;

  constructor(
    private readonly keepRounds = Infinity,
    private readonly keepRejects = Infinity,
  ) {}

  writeRound(rec: RoundRecord): void {
    this.roundsWritten++;
    this.rounds.push(rec);
    if (this.rounds.length > this.keepRounds) this.rounds.shift();
  }
  rejected(rec: RejectRecord): void {
    this.rejectCounts[rec.code] = (this.rejectCounts[rec.code] ?? 0) + 1;
    this.rejections.push(rec);
    if (this.rejections.length > this.keepRejects) this.rejections.shift();
  }
  event(kind: string, data: Record<string, unknown>): void {
    this.events.push({ kind, data });
    if (this.events.length > 1000) this.events.shift();
  }
  findRound(roundId: string): RoundRecord | undefined {
    return this.rounds.find((r) => r.roundId === roundId);
  }
}
