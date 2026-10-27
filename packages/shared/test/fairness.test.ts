import { describe, expect, it } from 'vitest';
import {
  derivePermutation,
  derivePermutations,
  deriveSequences,
  generateServerSeed,
  hashServerSeed,
  isPermutation,
  jackpotTile,
  verifyRound,
} from '../src';

const SEED = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

describe('provably fair derivation', () => {
  it('hash is SHA-256 of the hex seed string', () => {
    // sha256("abc")
    expect(hashServerSeed('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashServerSeed(SEED)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same seeds always give the same sequences', () => {
    const a = deriveSequences(SEED, 'r-1:1');
    const b = deriveSequences(SEED, 'r-1:1');
    expect(a).toEqual(b);
    expect(deriveSequences(SEED, 'r-1:2')).not.toEqual(a);
    expect(deriveSequences(generateServerSeed(), 'r-1:1')).not.toEqual(a);
  });

  it('is stable across releases (golden vector)', () => {
    // If this changes, every previously logged round becomes unverifiable.
    expect(derivePermutation(SEED, 'golden:0', 1).slice(0, 10)).toMatchInlineSnapshot(`
      [
        31,
        83,
        37,
        58,
        94,
        76,
        24,
        55,
        51,
        93,
      ]
    `);
  });

  it('produces valid permutations of 0..99 with stage lengths 91/90/99', () => {
    for (let r = 0; r < 500; r++) {
      const seed = generateServerSeed();
      const perms = derivePermutations(seed, `r-${r}:${r}`);
      perms.forEach((p) => expect(isPermutation(p)).toBe(true));
      const seqs = deriveSequences(seed, `r-${r}:${r}`);
      expect(seqs.map((s) => s.length)).toEqual([91, 90, 99]);
      expect(seqs[2]).not.toContain(jackpotTile(perms[2]));
    }
  });

  it('stages use independent streams', () => {
    const [p1, p2, p3] = derivePermutations(SEED, 'x:1');
    expect(p1).not.toEqual(p2);
    expect(p2).not.toEqual(p3);
  });

  it('chi-square: every tile is uniform over every position (100k rounds per stage)', () => {
    const N = 100_000;
    const seed = generateServerSeed();
    const counts = [1, 2, 3].map(() => new Float64Array(100 * 100));
    for (let r = 0; r < N; r++) {
      const perms = derivePermutations(seed, `chi-${r}:${r}`);
      for (let s = 0; s < 3; s++) {
        const c = counts[s];
        const p = perms[s];
        for (let pos = 0; pos < 100; pos++) c[pos * 100 + p[pos]]++;
      }
    }
    const expected = N / 100;
    const df = 99 * 99;
    for (let s = 0; s < 3; s++) {
      let chi = 0;
      let worstRowZ = 0;
      for (let pos = 0; pos < 100; pos++) {
        let row = 0;
        for (let t = 0; t < 100; t++) {
          const d = counts[s][pos * 100 + t] - expected;
          row += (d * d) / expected;
        }
        chi += row;
        worstRowZ = Math.max(worstRowZ, (row - 99) / Math.sqrt(2 * 99));
      }
      const z = (chi - df) / Math.sqrt(2 * df);
      // z > 5 on the full table, or any single position beyond 6 sigma, means a biased shuffle.
      expect(Math.abs(z), `stage ${s + 1} chi2=${chi.toFixed(0)} z=${z.toFixed(2)}`).toBeLessThan(5);
      expect(worstRowZ, `stage ${s + 1} worst position z`).toBeLessThan(6);
    }
  }, 120_000);
});

describe('verifyRound', () => {
  const clientSeed = 'room-1#42:42';
  const serverSeed = generateServerSeed();
  const sequences = deriveSequences(serverSeed, clientSeed);
  const base = { serverSeed, serverSeedHash: hashServerSeed(serverSeed), clientSeed, sequences };

  it('accepts an honest round, including an early-ended one', () => {
    expect(verifyRound({ ...base, played: [sequences[0], sequences[1].slice(0, 12), []] }).ok).toBe(true);
  });

  it('rejects a wrong hash, a tampered sequence or a tampered play log', () => {
    expect(verifyRound({ ...base, serverSeedHash: hashServerSeed('nope') }).hashOk).toBe(false);
    const bad = sequences.map((s) => [...s]);
    [bad[1][0], bad[1][1]] = [bad[1][1], bad[1][0]];
    expect(verifyRound({ ...base, sequences: bad }).sequencesOk).toEqual([true, false, true]);
    const played = [sequences[0].slice(0, 5).reverse(), [], []];
    expect(verifyRound({ ...base, played }).playedOk[0]).toBe(false);
  });
});
