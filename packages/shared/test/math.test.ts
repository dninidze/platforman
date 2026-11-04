import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MULTIPLIERS,
  MULTIPLIERS_100,
  STAGE_REMOVALS,
  formatMoney,
  getMultiplier,
  payout,
  reachProbability,
  survivalProbability,
  theoreticalRtp,
  type Stage,
} from '../src';

const SPEC = resolve(__dirname, '../../../../spec/multipliers.json');

describe('multiplier table', () => {
  it('has 91 / 90 / 99 values', () => {
    expect(MULTIPLIERS.map((r) => r.length)).toEqual([91, 90, 99]);
    expect(STAGE_REMOVALS).toEqual([91, 90, 99]);
  });

  it.runIf(existsSync(SPEC))('is identical to spec/multipliers.json (from Platforman math 031126 ZI.xlsx)', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
    expect(MULTIPLIERS).toEqual(spec.stages.map((s: { multipliers: number[] }) => s.multipliers));
  });

  it('getMultiplier(stage, k) maps k removals to table[k-1] (CHANGES_6 table)', () => {
    expect(getMultiplier(1, 0)).toBe(1);
    expect(getMultiplier(1, 1)).toBe(0.98);
    expect(getMultiplier(1, 91)).toBe(10.78);
    expect(getMultiplier(2, 0)).toBe(10.78);
    expect(getMultiplier(2, 1)).toBe(10.89);
    expect(getMultiplier(2, 90)).toBe(107);
    expect(getMultiplier(3, 0)).toBe(107);
    expect(getMultiplier(3, 1)).toBe(109);
    expect(getMultiplier(3, 99)).toBe(10_778);
    expect(() => getMultiplier(1, 92)).toThrow();
  });

  it('survivalProbability = (100 - k) / 100', () => {
    expect(survivalProbability(1, 0)).toBe(1);
    expect(survivalProbability(1, 91)).toBeCloseTo(0.09);
    expect(survivalProbability(2, 90)).toBeCloseTo(0.1);
    expect(survivalProbability(3, 99)).toBeCloseTo(0.01);
  });
});

describe('reference RTP (CHANGES_6 §1: flat 3% house edge)', () => {
  const range = (stage: Stage) => {
    const rtps = MULTIPLIERS[stage - 1].map((_, i) => theoreticalRtp(stage, i + 1));
    return { min: Math.min(...rtps) * 100, max: Math.max(...rtps) * 100 };
  };
  it('stage 1 (10x): 96.57% .. 97.37%', () => {
    expect(range(1).min).toBeCloseTo(96.57, 2);
    expect(range(1).max).toBeCloseTo(97.37, 2);
  });
  it('stage 2 (100x): 96.30% .. 97.04%', () => {
    expect(range(2).min).toBeCloseTo(96.3, 2);
    expect(range(2).max).toBeCloseTo(97.04, 1);
  });
  it('stage 3 (10kx): 96.62% .. 97.29%', () => {
    expect(range(3).min).toBeCloseTo(96.62, 1);
    expect(range(3).max).toBeCloseTo(97.29, 2);
  });
  it('every cash-out point is within 96.3% .. 97.4% (house edge about 3%)', () => {
    for (const s of [1, 2, 3] as Stage[]) {
      expect(range(s).min).toBeGreaterThan(96.29);
      expect(range(s).max).toBeLessThan(97.38);
    }
  });
  it('full path = 0.09 x 0.10 x 0.01 x 10,778 = 97.00%', () => {
    expect(reachProbability(3)).toBeCloseTo(0.009, 12);
    expect(theoreticalRtp(3, 99)).toBeCloseTo(0.97002, 10);
  });
});

describe('payout', () => {
  it('equals floor(bet x multiplier) exactly for every table value', () => {
    const bets = [1, 7, 10, 33, 99, 100, 101, 250, 999, 1234, 5000, 9999, 10000];
    for (let s = 0; s < 3; s++) {
      for (const m100 of MULTIPLIERS_100[s]) {
        for (const bet of bets) {
          const exact = (BigInt(bet) * BigInt(m100)) / 100n;
          expect(payout(bet, m100)).toBe(Number(exact));
        }
      }
    }
  });

  it('is capped at maxWinPerBet', () => {
    expect(payout(10000, 1_000_000, 1_000_000)).toBe(1_000_000);
    expect(payout(100, 1_000_000, 1_000_000)).toBe(1_000_000);
    expect(payout(99, 1_000_000, 1_000_000)).toBe(990_000);
  });

  it('formats minor units', () => {
    expect(formatMoney(123456)).toBe('1,234.56');
    expect(formatMoney(5)).toBe('0.05');
  });
});

describe('formatMultiplier (CHANGES_4 §1)', () => {
  it('keeps two decimals below 100x and drops them from 100x', async () => {
    const { formatMultiplier } = await import('../src');
    expect(formatMultiplier(1)).toBe('1.00x');
    expect(formatMultiplier(10.77)).toBe('10.77x');
    expect(formatMultiplier(94.88)).toBe('94.88x');
    expect(formatMultiplier(104.46)).toBe('104x');
    expect(formatMultiplier(1440)).toBe('1,440x');
    expect(formatMultiplier(10_000)).toBe('10,000x');
  });
});
