import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
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

/** In-memory audit log (tests, simulator). */
export class MemoryAuditLog implements AuditLog {
  readonly rounds: RoundRecord[] = [];
  readonly rejections: RejectRecord[] = [];
  readonly events: { kind: string; data: Record<string, unknown> }[] = [];
  writeRound(rec: RoundRecord): void {
    this.rounds.push(rec);
  }
  rejected(rec: RejectRecord): void {
    this.rejections.push(rec);
  }
  event(kind: string, data: Record<string, unknown>): void {
    this.events.push({ kind, data });
  }
}

/** Appends JSONL under dataDir: rounds.jsonl, rejections.jsonl, server.log. Keeps recent rounds in memory. */
export class FileAuditLog implements AuditLog {
  private readonly rejectStream: WriteStream;
  private readonly eventStream: WriteStream;
  private readonly recent = new Map<string, RoundRecord>();
  readonly roundsPath: string;
  rejectCounts: Record<string, number> = {};

  constructor(
    readonly dataDir: string,
    private readonly keepRecent = 500,
  ) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.roundsPath = join(dataDir, 'rounds.jsonl');
    this.rejectStream = createWriteStream(join(dataDir, 'rejections.jsonl'), { flags: 'a' });
    this.eventStream = createWriteStream(join(dataDir, 'server.log'), { flags: 'a' });
  }

  writeRound(rec: RoundRecord): void {
    // Sync append keeps the round log ordered and durable before the next round starts.
    appendFileSync(this.roundsPath, JSON.stringify(rec) + '\n');
    this.recent.set(rec.roundId, rec);
    if (this.recent.size > this.keepRecent) this.recent.delete(this.recent.keys().next().value!);
  }

  rejected(rec: RejectRecord): void {
    this.rejectCounts[rec.code] = (this.rejectCounts[rec.code] ?? 0) + 1;
    this.rejectStream.write(JSON.stringify({ level: 'info', msg: 'action_rejected', ...rec }) + '\n');
  }

  event(kind: string, data: Record<string, unknown>): void {
    this.eventStream.write(JSON.stringify({ at: Date.now(), kind, ...data }) + '\n');
  }

  recentRounds(roomId?: string, limit = 30): RoundRecord[] {
    const all = [...this.recent.values()].filter((r) => !roomId || r.roomId === roomId);
    return all.slice(-limit).reverse();
  }

  async findRound(roundId: string): Promise<RoundRecord | null> {
    const hit = this.recent.get(roundId);
    if (hit) return hit;
    if (!existsSync(this.roundsPath)) return null;
    const rl = createInterface({ input: createReadStream(this.roundsPath) });
    for await (const line of rl) {
      if (!line.includes(`"roundId":"${roundId}"`)) continue;
      rl.close();
      return JSON.parse(line) as RoundRecord;
    }
    return null;
  }
}
