import { describe, expect, it } from 'vitest';
import { TOP_N, TopResults, type TopEntry } from '../src/topResults';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

const entry = (i: number, t: number, man: number, cashX: number, win: number): TopEntry => ({
  id: `EUR-1#${i}`,
  t,
  reached: 2,
  highlights: { topMan: { multiplier: man, survived: 100 + i }, topCashout: { multiplier: cashX, amount: win } },
});

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe('Top results (CHANGES_6 §10)', () => {
  it('ranks by Top man x by default, or by Top cashout x / Win, highest first', () => {
    const top = new TopResults(null);
    top.add(entry(1, NOW - HOUR, 50, 2, 900));
    top.add(entry(2, NOW - 2 * HOUR, 120, 30, 100));
    top.add(entry(3, NOW - 3 * HOUR, 9, 12, 5_000));
    expect(top.query('24h', 'man', NOW).map((e) => e.id)).toEqual(['EUR-1#2', 'EUR-1#1', 'EUR-1#3']);
    expect(top.query('24h', 'cashX', NOW).map((e) => e.id)).toEqual(['EUR-1#2', 'EUR-1#3', 'EUR-1#1']);
    expect(top.query('24h', 'cashWin', NOW).map((e) => e.id)).toEqual(['EUR-1#3', 'EUR-1#1', 'EUR-1#2']);
  });

  it('uses rolling windows, not calendar periods', () => {
    const top = new TopResults(null);
    top.add(entry(1, NOW - 23 * HOUR, 10, 1, 1), NOW);
    top.add(entry(2, NOW - 25 * HOUR, 20, 1, 1), NOW);
    top.add(entry(3, NOW - 8 * DAY, 30, 1, 1), NOW);
    top.add(entry(4, NOW - 40 * DAY, 40, 1, 1), NOW);
    top.add(entry(5, NOW - 200 * DAY, 50, 1, 1), NOW);
    expect(top.query('24h', 'man', NOW).map((e) => e.id)).toEqual(['EUR-1#1']);
    expect(top.query('week', 'man', NOW).map((e) => e.id)).toEqual(['EUR-1#2', 'EUR-1#1']);
    expect(top.query('month', 'man', NOW).map((e) => e.id)).toEqual(['EUR-1#3', 'EUR-1#2', 'EUR-1#1']);
    expect(top.query('year', 'man', NOW).map((e) => e.id)).toEqual(['EUR-1#5', 'EUR-1#4', 'EUR-1#3', 'EUR-1#2', 'EUR-1#1']);
  });

  it('keeps only each bucket\'s top 10 per key, which still gives the exact top 10 over whole buckets', () => {
    const top = new TopResults(null);
    const all: TopEntry[] = [];
    for (let i = 0; i < 400; i++) {
      const e = entry(i, NOW - (i % 20) * HOUR - 1, (i * 37) % 997, (i * 53) % 499, (i * 71) % 10_007);
      all.push(e);
      top.add(e, NOW);
    }
    for (const sort of ['man', 'cashX', 'cashWin'] as const) {
      const key = (e: TopEntry) => (sort === 'man' ? e.highlights.topMan!.multiplier : sort === 'cashX' ? e.highlights.topCashout!.multiplier : e.highlights.topCashout!.amount);
      const expected = [...all].sort((a, b) => key(b) - key(a) || b.t - a.t).slice(0, TOP_N).map(key);
      expect(top.query('24h', sort, NOW).map(key)).toEqual(expected);
    }
  });

  it('survives a reload through storage; skips rounds without that highlight', () => {
    const store = memory();
    const a = new TopResults(store);
    a.add({ id: 'EUR-1#1', t: NOW - HOUR, reached: 1, highlights: { topMan: { multiplier: 3, survived: 20 }, topCashout: null } });
    const b = new TopResults(store);
    expect(b.query('24h', 'man', NOW)).toHaveLength(1);
    expect(b.query('24h', 'cashWin', NOW)).toHaveLength(0);
    expect(new TopResults({ getItem: () => '{broken', setItem: () => {} }).query('24h', 'man', NOW)).toEqual([]);
  });
});
