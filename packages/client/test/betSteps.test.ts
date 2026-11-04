import { describe, expect, it } from 'vitest';
import { AMOUNT_RE, formatAmount, stepBet } from '../src/betSteps';

const up = (v: number) => stepBet(v, 1, 10, 10_000);
const down = (v: number) => stepBet(v, -1, 10, 10_000);

describe('bet amount steps (CHANGES_7 §7)', () => {
  it('0.10 up to 1, 1 up to 10, 5 up to 100', () => {
    expect([10, 90, 100, 900, 1_000, 1_500, 9_500, 10_000].map(up)).toEqual([20, 100, 200, 1_000, 1_500, 2_000, 10_000, 10_000]);
    expect([10, 100, 200, 1_000, 1_500, 10_000].map(down)).toEqual([10, 90, 100, 900, 1_000, 9_500]);
  });
  it('off-grid amounts move to the next grid value', () => {
    expect(up(155)).toBe(200);
    expect(down(155)).toBe(100);
    expect(up(1_234)).toBe(1_500);
    expect(down(1_234)).toBe(1_000);
  });
  it('typed amounts: up to 2 decimals; 100 shown without decimals', () => {
    expect(['1', '1.5', '12.34', '100', '.5', ''].every((v) => AMOUNT_RE.test(v))).toBe(true);
    expect(['1.234', '1000', 'a', '1,5'].some((v) => AMOUNT_RE.test(v))).toBe(false);
    expect([10, 150, 9_950, 10_000].map(formatAmount)).toEqual(['0.10', '1.50', '99.50', '100']);
  });
});
