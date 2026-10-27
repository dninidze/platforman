import { describe, expect, it } from 'vitest';
import { MockWallet } from '../src/wallet';
import { flush, setupRoom } from './helpers';

describe('MockWallet', () => {
  it('gives each new player 1,000 demo credits in minor units', async () => {
    const w = new MockWallet(100_000);
    expect(await w.getBalance('new', 'EUR')).toBe(100_000);
  });

  it('debit and credit are idempotent on txId (never double-paid)', async () => {
    const w = new MockWallet(10_000);
    expect(await w.debit('a', 500, 'tx1', 'r1')).toEqual({ ok: true, balance: 9_500 });
    expect(await w.debit('a', 500, 'tx1', 'r1')).toEqual({ ok: true, balance: 9_500, duplicate: true });
    expect(await w.credit('a', 2_000, 'tx2', 'r1')).toEqual({ ok: true, balance: 11_500 });
    expect(await w.credit('a', 2_000, 'tx2', 'r1')).toMatchObject({ ok: true, duplicate: true });
    expect(await w.getBalance('a', 'EUR')).toBe(11_500);
    expect(w.ledger).toHaveLength(2);
  });

  it('rejects overdrafts, non-integer amounts and txId reuse across kinds', async () => {
    const w = new MockWallet(100);
    expect(await w.debit('a', 101, 'x', 'r')).toMatchObject({ ok: false, error: 'INSUFFICIENT_FUNDS' });
    expect(await w.debit('a', 1.5, 'y', 'r')).toMatchObject({ ok: false, error: 'INVALID' });
    await w.debit('a', 10, 'z', 'r');
    expect(await w.credit('a', 10, 'z', 'r')).toMatchObject({ ok: false, error: 'INVALID' });
  });

  it('rollback reverses once', async () => {
    const w = new MockWallet(1_000);
    await w.debit('a', 300, 'b1', 'r');
    expect(await w.rollback('b1')).toEqual({ ok: true, balance: 1_000 });
    expect(await w.rollback('b1')).toMatchObject({ ok: true, duplicate: true, balance: 1_000 });
    expect(await w.rollback('nope')).toMatchObject({ ok: false, error: 'UNKNOWN_TX' });
  });
});

describe('room <-> wallet', () => {
  it('retries failed credits with the same txId and pays exactly once', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 1_000, h.safeTile(1));
    h.clock.advanceTo(10_000 + 500);
    h.wallet.failNextCredits = 2;
    const r = h.room.cashout('a');
    expect(r).toMatchObject({ ok: true, amount: 1_010 });
    await flush();
    expect(await h.wallet.getBalance('a')).toBe(99_000);
    for (let i = 0; i < 5; i++) {
      h.clock.advance(1_000);
      await flush();
    }
    expect(await h.wallet.getBalance('a')).toBe(99_000 + 1_010);
    const failures = h.audit.events.filter((e) => e.kind === 'credit_failed');
    expect(failures).toHaveLength(2);
    expect(new Set(failures.map((f) => f.data.txId))).toEqual(new Set([`EUR-1#1:a:win`]));
    expect(h.wallet.ledger.filter((e) => e.kind === 'credit')).toHaveLength(1);
    // Replaying the same credit (e.g. after a crash) changes nothing.
    expect(await h.wallet.credit('a', 1_010, 'EUR-1#1:a:win', 'EUR-1#1')).toMatchObject({ duplicate: true });
    expect(await h.wallet.getBalance('a')).toBe(99_000 + 1_010);
  });

  it('ledger balances: staked - paid equals the player balance change over many rounds', async () => {
    const h = setupRoom({ bettingMs: 1_000 });
    const ids = ['a', 'b', 'c', 'd'];
    h.join(...ids);
    for (let round = 0; round < 6; round++) {
      for (const [i, id] of ids.entries()) await h.room.bet(id, 100 + i * 33, (i * 17 + round) % 100);
      h.clock.advance(1_000 + 500 * (2 + round));
      h.room.cashout('a');
      h.room.cashout('c');
      h.clock.advance(200_000);
      await flush();
    }
    let staked = 0;
    let paid = 0;
    for (const r of h.audit.rounds) {
      staked += r.totals.staked;
      paid += r.totals.paid;
    }
    let total = 0;
    for (const id of ids) total += await h.wallet.getBalance(id);
    expect(total).toBe(ids.length * 100_000 - staked + paid);
  });
});
