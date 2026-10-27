import table from './multipliers.json';
import { STAGE_REMOVALS, TILE_COUNT, type Stage } from './constants';

/**
 * Multiplier tables, taken verbatim from spec/multipliers.json.
 * MULTIPLIERS[s][i] = multiplier after (i+1) tiles are Gone in stage s+1.
 */
export const MULTIPLIERS: readonly (readonly number[])[] = table.stages.map((s) => Object.freeze([...s.multipliers]));

/** Same tables in integer hundredths (1.01x -> 101), so payouts never touch float rounding. */
export const MULTIPLIERS_100: readonly (readonly number[])[] = MULTIPLIERS.map((row) =>
  Object.freeze(row.map((m) => Math.round(m * 100))),
);

function validate(): void {
  if (MULTIPLIERS.length !== 3) throw new Error('multipliers.json must have 3 stages');
  MULTIPLIERS.forEach((row, s) => {
    if (row.length !== STAGE_REMOVALS[s]) {
      throw new Error(`stage ${s + 1} must have ${STAGE_REMOVALS[s]} multipliers, got ${row.length}`);
    }
    row.forEach((m, i) => {
      if (Math.abs(m * 100 - MULTIPLIERS_100[s][i]) > 1e-6) throw new Error(`multiplier ${m} has more than 2 decimals`);
    });
  });
}
validate();

/**
 * Multiplier (as a number) after k removals in a stage. k = 0 means "before the first removal of
 * this stage": 1.00x for stage 1, otherwise the previous stage's final value (carried through
 * intermission).
 */
export function getMultiplier(stage: Stage, k: number): number {
  return getMultiplier100(stage, k) / 100;
}

export function getMultiplier100(stage: Stage, k: number): number {
  const len = STAGE_REMOVALS[stage - 1];
  if (!Number.isInteger(k) || k < 0 || k > len) throw new RangeError(`k=${k} out of range for stage ${stage}`);
  if (k === 0) {
    if (stage === 1) return 100;
    const prev = MULTIPLIERS_100[stage - 2];
    return prev[prev.length - 1];
  }
  return MULTIPLIERS_100[stage - 1][k - 1];
}

/** Multiplier after the next removal, or null when the stage has no removals left. */
export function getNextMultiplier100(stage: Stage, k: number): number | null {
  return k < STAGE_REMOVALS[stage - 1] ? MULTIPLIERS_100[stage - 1][k] : null;
}

/** Probability that a given tile survives the first k removals of a stage: (100-k)/100. */
export function survivalProbability(_stage: Stage, k: number): number {
  return (TILE_COUNT - k) / TILE_COUNT;
}

/** Probability a player sitting on the board at round start is still alive when `stage` begins. */
export function reachProbability(stage: Stage): number {
  let p = 1;
  for (let s = 1; s < stage; s++) p *= survivalProbability(s as Stage, STAGE_REMOVALS[s - 1]);
  return p;
}

/** Theoretical RTP of "cash out right after the k-th removal of `stage`" (no win cap applied). */
export function theoreticalRtp(stage: Stage, k: number): number {
  return reachProbability(stage) * survivalProbability(stage, k) * getMultiplier(stage, k);
}

/** Payout in minor units: floor(bet * multiplier), computed in integers, then capped. */
export function payout(betMinor: number, multiplier100: number, maxWinMinor = Infinity): number {
  const raw = betMinor * multiplier100;
  const value = (raw - (raw % 100)) / 100;
  return Math.min(value, maxWinMinor);
}

/** Minor units -> "12.34" (two decimals). */
export function formatMoney(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
}

export function formatMultiplier100(m100: number): string {
  const whole = Math.floor(m100 / 100);
  return `${whole.toLocaleString('en-US')}.${(m100 % 100).toString().padStart(2, '0')}x`;
}
