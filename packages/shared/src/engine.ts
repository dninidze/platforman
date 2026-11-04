import { STAGE_REMOVALS, TILE_COUNT, type Stage } from './constants';
import { getMultiplier100, getNextMultiplier100, payout } from './math';
import type { ErrorCode, Phase, PlayerState, RoundHighlights } from './protocol';

/**
 * Pure, timer-free round state machine. The server wraps it with timing, wallet and networking;
 * the simulator drives it directly. It never decides *when* things happen, only *what* happens.
 */

export interface EngineLimits {
  tileCapacity: number;
  minBet: number;
  maxBet: number;
  maxWinPerBet: number;
}

export type Outcome = 'cashout' | 'maxWin' | 'survived' | 'lost' | null;

export interface RoundPlayer {
  id: string;
  bet: number;
  tile: number;
  state: PlayerState;
  payout: number;
  /** Multiplier (hundredths) the player was paid at. */
  multiplier100: number | null;
  outcome: Outcome;
  resolvedStage: Stage | null;
  resolvedK: number | null;
  moves: number;
  /** Multiplier (hundredths) at which bet x multiplier reaches maxWinPerBet. */
  capAt100: number;
}

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; reason: ErrorCode };

export interface TickResult {
  stage: Stage;
  /** Removals done in this stage after this tick. */
  k: number;
  tile: number;
  multiplier100: number;
  losers: RoundPlayer[];
  /** Players force-cashed at maxWinPerBet on this tick. */
  forced: RoundPlayer[];
  stageComplete: boolean;
  /** Players paid at the end of stage 3. */
  survivors: RoundPlayer[];
}

export class RoundCore {
  phase: Phase = 'betting';
  stage: Stage = 1;
  /** Removals done in the current stage. */
  removed = 0;
  readonly counts = new Uint8Array(TILE_COUNT);
  readonly gone = new Uint8Array(TILE_COUNT);
  readonly players = new Map<string, RoundPlayer>();
  /** Tiles actually removed per stage. */
  readonly played: number[][] = [[], [], []];
  /** Players currently standing on the board (betting or alive). */
  onBoard = 0;
  /** Stage in which the board emptied (fast finish), if it did. */
  emptiedAtStage: Stage | null = null;

  private readonly tilePlayers: Set<RoundPlayer>[] = Array.from({ length: TILE_COUNT }, () => new Set());
  private capQueue: RoundPlayer[] = [];
  private capPos = 0;

  constructor(
    /** Full removal sequences: [91, 90, 99] entries (longer arrays are truncated). */
    private readonly sequences: readonly (readonly number[])[],
    readonly limits: EngineLimits,
  ) {
    if (sequences.length !== 3) throw new Error('need 3 sequences');
    sequences.forEach((s, i) => {
      if (s.length < STAGE_REMOVALS[i]) throw new Error(`stage ${i + 1} sequence too short`);
    });
  }

  get multiplier100(): number {
    return getMultiplier100(this.stage, this.removed);
  }

  get nextMultiplier100(): number | null {
    // In intermission the next removal is the first one of the next stage.
    if (this.phase === 'intermission') return getNextMultiplier100((this.stage + 1) as Stage, 0);
    return getNextMultiplier100(this.stage, this.removed);
  }

  get stageLength(): number {
    return STAGE_REMOVALS[this.stage - 1];
  }

  get stageDone(): boolean {
    return this.removed >= this.stageLength;
  }

  /** Cashout is open while running/intermission, except before the first removal of stage 1. */
  get cashoutOpen(): boolean {
    if (this.phase !== 'running' && this.phase !== 'intermission') return false;
    return !(this.stage === 1 && this.removed === 0);
  }

  isFull(tile: number): boolean {
    return this.counts[tile] >= this.limits.tileCapacity;
  }

  tilePlayerIds(tile: number): string[] {
    return [...this.tilePlayers[tile]].map((p) => p.id);
  }

  placeBet(id: string, amount: number, tile: number): ActionResult<{ player: RoundPlayer }> {
    if (this.phase !== 'betting') return fail('PHASE');
    const existing = this.players.get(id);
    if (existing && existing.state === 'betting') return fail('PHASE');
    if (!Number.isInteger(amount) || amount < this.limits.minBet || amount > this.limits.maxBet) return fail('BET_LIMIT');
    if (!validTile(tile)) return fail('TILE_GONE');
    if (this.isFull(tile)) return fail('TILE_FULL');
    const player: RoundPlayer = {
      id,
      bet: amount,
      tile,
      state: 'betting',
      payout: 0,
      multiplier100: null,
      outcome: null,
      resolvedStage: null,
      resolvedK: null,
      moves: 0,
      capAt100: Math.ceil((this.limits.maxWinPerBet * 100) / amount),
    };
    this.players.set(id, player);
    this.occupy(player, tile);
    return { ok: true, player };
  }

  cancelBet(id: string): ActionResult<{ player: RoundPlayer }> {
    const p = this.players.get(id);
    if (this.phase !== 'betting' || !p || p.state !== 'betting') return fail('PHASE');
    this.vacate(p);
    this.players.delete(id);
    return { ok: true, player: p };
  }

  move(id: string, tile: number): ActionResult<{ player: RoundPlayer; from: number }> {
    const p = this.players.get(id);
    if (!p) return fail('PHASE');
    const movable =
      (this.phase === 'betting' && p.state === 'betting') ||
      ((this.phase === 'running' || this.phase === 'intermission') && p.state === 'alive');
    if (!movable) return fail(p.state === 'lost' ? 'TOO_LATE' : 'PHASE');
    if (!validTile(tile) || this.gone[tile]) return fail('TILE_GONE');
    const from = p.tile;
    if (from === tile) return { ok: true, player: p, from };
    if (this.isFull(tile)) return fail('TILE_FULL');
    this.vacate(p);
    this.occupy(p, tile);
    p.moves++;
    return { ok: true, player: p, from };
  }

  cashout(id: string): ActionResult<{ player: RoundPlayer }> {
    const p = this.players.get(id);
    if (!p) return fail('PHASE');
    if (p.state === 'lost') return fail('TOO_LATE');
    if (p.state !== 'alive' || !this.cashoutOpen) return fail('PHASE');
    this.settle(p, this.multiplier100, 'cashout');
    return { ok: true, player: p };
  }

  /** BETTING -> RUNNING stage 1. */
  startRunning(): void {
    if (this.phase !== 'betting') throw new Error(`startRunning in ${this.phase}`);
    this.phase = 'running';
    for (const p of this.players.values()) if (p.state === 'betting') p.state = 'alive';
    this.capQueue = [...this.players.values()].sort((a, b) => a.capAt100 - b.capAt100);
    this.capPos = 0;
  }

  /** Remove the next tile of the current stage, resolve losers, cap hits and stage end. */
  tick(): TickResult {
    if (this.phase !== 'running' || this.stageDone) throw new Error(`tick in ${this.phase}/${this.removed}`);
    const stage = this.stage;
    const tile = this.sequences[stage - 1][this.removed];
    this.removed++;
    this.gone[tile] = 1;
    this.played[stage - 1].push(tile);

    const losers: RoundPlayer[] = [];
    for (const p of this.tilePlayers[tile]) {
      p.state = 'lost';
      p.outcome = 'lost';
      p.resolvedStage = stage;
      p.resolvedK = this.removed;
      losers.push(p);
    }
    this.tilePlayers[tile].clear();
    this.onBoard -= losers.length;
    this.counts[tile] = 0;

    const m100 = this.multiplier100;
    const forced: RoundPlayer[] = [];
    while (this.capPos < this.capQueue.length && this.capQueue[this.capPos].capAt100 <= m100) {
      const p = this.capQueue[this.capPos++];
      if (p.state !== 'alive') continue;
      this.settle(p, m100, 'maxWin');
      forced.push(p);
    }

    const stageComplete = this.stageDone;
    const survivors: RoundPlayer[] = [];
    if (stageComplete) {
      if (stage === 3) {
        for (const p of this.players.values()) {
          if (p.state !== 'alive') continue;
          this.settle(p, m100, 'survived');
          survivors.push(p);
        }
        if (survivors.length === 0 && this.emptiedAtStage === null) this.emptiedAtStage = 3;
        this.phase = 'ended';
      } else {
        // Resurrection: all tiles come back as soon as intermission starts; survivors keep their tiles.
        this.phase = 'intermission';
        this.gone.fill(0);
      }
    }
    return { stage, k: this.removed, tile, multiplier100: m100, losers, forced, stageComplete, survivors };
  }

  /** INTERMISSION -> RUNNING next stage: all tiles come back, survivors keep their tiles. */
  startNextStage(): void {
    if (this.phase !== 'intermission' || this.stage === 3) throw new Error(`startNextStage in ${this.phase}`);
    this.stage = (this.stage + 1) as Stage;
    this.removed = 0;
    this.gone.fill(0);
    this.phase = 'running';
  }

  /** Mark the round over (normal end or fast finish). */
  end(): void {
    if (this.onBoard === 0 && this.emptiedAtStage === null && this.phase !== 'ended') this.emptiedAtStage = this.stage;
    this.phase = 'ended';
  }

  /** Remaining sequence of the current stage; used only by the fast-finish path in the server. */
  remainingInStage(): number {
    return this.stageLength - this.removed;
  }

  potentialWin(p: RoundPlayer): number {
    return payout(p.bet, this.multiplier100, this.limits.maxWinPerBet);
  }

  private settle(p: RoundPlayer, m100: number, outcome: Exclude<Outcome, 'lost' | null>): void {
    const amount = payout(p.bet, m100, this.limits.maxWinPerBet);
    p.state = 'cashedOut';
    p.payout = amount;
    p.multiplier100 = m100;
    p.outcome = amount >= this.limits.maxWinPerBet ? (outcome === 'survived' ? 'survived' : 'maxWin') : outcome;
    p.resolvedStage = this.stage;
    p.resolvedK = this.removed;
    this.vacate(p);
  }

  private occupy(p: RoundPlayer, tile: number): void {
    p.tile = tile;
    this.tilePlayers[tile].add(p);
    this.counts[tile]++;
    this.onBoard++;
  }

  private vacate(p: RoundPlayer): void {
    if (this.tilePlayers[p.tile].delete(p)) {
      this.counts[p.tile]--;
      this.onBoard--;
    }
  }
}

function fail(reason: ErrorCode): { ok: false; reason: ErrorCode } {
  return { ok: false, reason };
}

function validTile(tile: number): boolean {
  return Number.isInteger(tile) && tile >= 0 && tile < TILE_COUNT;
}

/** Removals in all stages before `stage`. */
const removalsBefore = (stage: Stage) => STAGE_REMOVALS.slice(0, stage - 1).reduce((a, b) => a + b, 0);

/**
 * CHANGES_7 §2: tiles survived in the whole round by a resolved player (cashed out after k removals: k;
 * lost at removal k: k - 1; survivor: 280), or null while the player is still live.
 */
export function tilesSurvived(p: RoundPlayer): number | null {
  if (p.outcome === 'survived') return removalsBefore(3) + STAGE_REMOVALS[2];
  if (p.resolvedStage === null || p.resolvedK === null) return null;
  return removalsBefore(p.resolvedStage) + p.resolvedK - (p.outcome === 'lost' ? 1 : 0);
}

/**
 * CHANGES_7 §3: Top man is the player who lasted longest, cash-outs included (ties to the higher multiplier),
 * so Top man >= Top cashout. (Was CHANGES_5 §5: the player who lasted longest without cashing out.) A player lost at removal k of
 * stage s survived removalsBefore(s) + k - 1 tiles and last stood at the multiplier after removal k - 1.
 * Survivors paid at the end of stage 3 survived all 280. Top cashout: highest multiplier cashed out, ties
 * to the larger amount.
 */
export function roundHighlights(players: Iterable<RoundPlayer>): RoundHighlights {
  let topMan: RoundHighlights['topMan'] = null;
  let topCashout: RoundHighlights['topCashout'] = null;
  for (const p of players) {
    const survived = tilesSurvived(p);
    if (survived !== null) {
      const multiplier =
        p.outcome === 'lost' ? getMultiplier100(p.resolvedStage!, p.resolvedK! - 1) / 100 : (p.multiplier100 ?? 0) / 100;
      if (!topMan || survived! > topMan.survived || (survived === topMan.survived && multiplier > topMan.multiplier)) topMan = { multiplier, survived: survived! };
    }
    if ((p.outcome === 'cashout' || p.outcome === 'maxWin') && p.multiplier100 !== null) {
      const m = p.multiplier100 / 100;
      if (!topCashout || m > topCashout.multiplier || (m === topCashout.multiplier && p.payout > topCashout.amount)) {
        topCashout = { multiplier: m, amount: p.payout };
      }
    }
  }
  return { topMan, topCashout };
}
