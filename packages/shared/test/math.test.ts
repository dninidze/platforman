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

  it.runIf(existsSync(SPEC))('is identical to spec/multipliers.json', () => {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
    expect(MULTIPLIERS).toEqual(spec.stages.map((s: { multipliers: number[] }) => s.multipliers));
  });

  it('getMultiplier(stage, k) maps k removals to table[k-1]', () => {
    expect(getMultiplier(1, 0)).toBe(1);
    expect(getMultiplier(1, 1)).toBe(1.01);
    expect(getMultiplier(1, 91)).toBe(10.77);
    expect(getMultiplier(2, 0)).toBe(10.77);
    expect(getMultiplier(2, 90)).toBe(104.46);
    expect(getMultiplier(3, 0)).toBe(104.46);
    expect(getMultiplier(3, 99)).toBe(10000);
    expect(() => getMultiplier(1, 92)).toThrow();
  });

  it('survivalProbability = (100 - k) / 100', () => {
    expect(survivalProbability(1, 0)).toBe(1);
    expect(survivalProbability(1, 91)).toBeCloseTo(0.09);
    expect(survivalProbability(2, 90)).toBeCloseTo(0.1);
    expect(survivalProbability(3, 99)).toBeCloseTo(0.01);
  });
});

describe('reference RTP (§4)', () => {
  const range = (stage: Stage) => {
    const rtps = MULTIPLIERS[stage - 1].map((_, i) => theoreticalRtp(stage, i + 1));
    return { min: Math.min(...rtps), max: Math.max(...rtps), argmax: rtps.indexOf(Math.max(...rtps)) + 1 };
  };

  it('stage 1: 95.04% .. 99.99%, best after tile 1', () => {
    const r = range(1);
    expect(r.min * 100).toBeCloseTo(95.04, 2);
    expect(r.max * 100).toBeCloseTo(99.99, 2);
    expect(r.argmax).toBe(1);
  });
  it('stage 2: 92.10% .. 96.85%', () => {
    const r = range(2);
    expect(r.min * 100).toBeCloseTo(92.1, 1);
    expect(r.max * 100).toBeCloseTo(96.85, 2);
  });
  it('stage 3: 89.35% .. 93.56%', () => {
    const r = range(3);
    expect(r.min * 100).toBeCloseTo(89.35, 2);
    expect(Math.abs(r.max * 100 - 93.56)).toBeLessThan(0.01); // 93.555 in exact terms
  });
  it('full 10,000x path = 0.09 x 0.10 x 0.01 x 10,000 = 90%', () => {
    expect(reachProbability(3)).toBeCloseTo(0.009, 12);
    expect(theoreticalRtp(3, 99)).toBeCloseTo(0.9, 10);
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
