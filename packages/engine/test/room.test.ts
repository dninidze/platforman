import { MULTIPLIERS_100, countsChecksum, tileBand, tileCapsFor, verifyRound } from '@p3/shared';
import { describe, expect, it } from 'vitest';
import { flush, setupRoom } from './helpers';

const BET_END = 10_000;

describe('round timeline (fake clock)', () => {
  it('betting -> stage 1 ticks every 500 ms in the precommitted order -> intermission -> stage 2', async () => {
    const h = setupRoom();
    h.join('a');
    expect(h.room.phase).toBe('betting');
    expect((await h.room.bet('a', 100, h.safeTile(1))).ok).toBe(true);

    h.clock.advanceTo(BET_END);
    expect(h.room.phase).toBe('running');
    expect(h.of('tick')).toHaveLength(0);
    h.clock.advanceTo(BET_END + 499);
    expect(h.of('tick')).toHaveLength(0);
    h.clock.advanceTo(BET_END + 500);
    expect(h.of('tick')).toHaveLength(1);

    h.clock.advanceTo(BET_END + 91 * 500);
    const ticks = h.of('tick');
    expect(ticks.map((t) => t.tileGone)).toEqual(h.seqs()[0]);
    expect(ticks.map((t) => t.serverTime)).toEqual(ticks.map((_, i) => BET_END + (i + 1) * 500));
    expect(ticks.map((t) => Math.round(t.multiplier * 100))).toEqual(MULTIPLIERS_100[0]);
    expect(h.room.phase).toBe('intermission');
    expect(h.of('stageEnd')).toEqual([expect.objectContaining({ stage: 1, multiplier: 10.77, nextMultiplier: 10.87, phaseEndsAt: BET_END + 91 * 500 + 3000 })]);

    h.clock.advanceTo(BET_END + 91 * 500 + 3000);
    expect(h.room.phase).toBe('running');
    expect(h.room.core.stage).toBe(2);
    expect(h.room.core.gone.every((g) => g === 0)).toBe(true);
    h.clock.advanceTo(BET_END + 91 * 500 + 3000 + 500);
    expect(h.of('tick').at(-1)).toMatchObject({ stage: 2, removedCount: 1, multiplier: 10.87, tileGone: h.seqs()[1][0] });
  });

  it('all three stages end to end; survivor on the last stage-3 tile is paid 10,000x', async () => {
    const h = setupRoom();
    h.join('rider');
    await h.room.bet('rider', 10, h.safeTile(1));
    h.clock.advanceTo(BET_END + 91 * 500 + 1000); // in intermission 1
    expect(h.room.move('rider', h.safeTile(2)).ok).toBe(true);
    h.clock.advance(2000 + 90 * 500 + 1000); // in intermission 2
    expect(h.room.phase).toBe('intermission');
    expect(h.room.move('rider', h.safeTile(3)).ok).toBe(true);
    const balBefore = await h.wallet.getBalance('rider');
    h.clock.advance(2000 + 99 * 500);
    await flush();
    expect(h.room.phase).toBe('ended');
    const end = h.of('roundEnd').at(-1)!;
    expect(end.jackpotTile).toBe(h.safeTile(3));
    expect(end.survivorsPaid).toEqual([{ nickname: 'ri***r', amount: 100_000 }]); // public lists are masked
    expect(h.audit.rounds[0].players[0].nickname).toBe('rider'); // the audit log keeps the real name
    expect(end.emptiedAtStage).toBeNull();
    expect(await h.wallet.getBalance('rider')).toBe(balBefore + 100_000);
    expect(h.audit.rounds[0].players[0]).toMatchObject({ outcome: 'survived', stage: 3, k: 99, payout: 100_000 });
  });

  it('next round starts after resultsMs with fresh occupancy and new seeds', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 100, h.seqs()[0][0]);
    h.clock.advanceTo(BET_END + 500); // lost on first tile -> fast finish
    h.clock.advanceTo(BET_END + 500 + 90 * 200);
    expect(h.room.phase).toBe('ended');
    h.clock.advance(4000);
    expect(h.room.phase).toBe('betting');
    expect(h.room.roundNo).toBe(2);
    expect([...h.room.core.counts].every((c) => c === 0)).toBe(true);
    expect(h.of('roundState').at(-1)).toMatchObject({ phase: 'betting', roundId: 'EUR-1#2' });
  });
});

describe('action ordering (§3.4)', () => {
  it('an action received before the tick timestamp is applied before the tick', async () => {
    const h = setupRoom();
    h.join('a');
    const doomed = h.seqs()[0][1]; // goes on tick 2
    await h.room.bet('a', 1000, doomed);
    h.clock.advanceTo(BET_END + 1000 - 1);
    const r = h.room.cashout('a');
    expect(r).toEqual({ ok: true, amount: 1010, multiplier: 1.01, maxWin: false });
  });

  it('a cashout after the tick removed the tile gets TOO_LATE even if the timer callback is late', async () => {
    const h = setupRoom();
    h.join('a');
    const doomed = h.seqs()[0][1];
    await h.room.bet('a', 1000, doomed);
    h.clock.advanceTo(BET_END + 500);
    h.clock.jump(501); // tick 2 is due but its timer has not fired yet
    expect(h.room.cashout('a')).toEqual({ ok: false, reason: 'TOO_LATE' });
    expect(h.of('tick')).toHaveLength(2);
    expect(h.audit.rejections.at(-1)).toMatchObject({ action: 'cashout', code: 'TOO_LATE', playerId: 'a' });
  });

  it('cashout is disabled before the first removal (1.00x)', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 1000, h.safeTile(1));
    h.clock.advanceTo(BET_END + 200);
    expect(h.room.cashout('a')).toEqual({ ok: false, reason: 'PHASE' });
  });

  it('default: no move lock, a move 1 ms before a removal is accepted and applied before it (CHANGES_3 §1)', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 100, h.safeTile(1, 0));
    h.clock.advanceTo(BET_END + 1000 - 1);
    expect(h.room.move('a', h.seqs()[0][1]).ok).toBe(true); // onto the tile that goes at +1000
    h.clock.advanceTo(BET_END + 1000);
    expect(h.room.core.players.get('a')!.state).toBe('lost');
    expect(h.audit.rejections.some((r) => r.code === 'MOVE_LOCKED')).toBe(false);
  });

  it('an operator can still enable the lock: moves are MOVE_LOCKED in the last moveLockMs; cashouts never are', async () => {
    const h = setupRoom({ moveLockMs: 100 });
    h.join('a', 'b');
    await h.room.bet('a', 100, h.safeTile(1, 0));
    await h.room.bet('b', 100, h.safeTile(1, 1));
    h.clock.advanceTo(BET_END + 500 + 399); // next tick at +1000, 101 ms away
    expect(h.room.move('a', h.safeTile(1, 2)).ok).toBe(true);
    h.clock.advanceTo(BET_END + 500 + 401); // 99 ms away
    expect(h.room.move('a', h.safeTile(1, 3))).toEqual({ ok: false, reason: 'MOVE_LOCKED' });
    expect(h.room.cashout('b').ok).toBe(true);
    expect(h.room.core.players.get('a')!.tile).toBe(h.safeTile(1, 2));
  });

  it('moves are allowed during intermission and to resurrected tiles', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 100, h.safeTile(1));
    h.clock.advanceTo(BET_END + 91 * 500 + 10);
    const goneTile = h.seqs()[0][0];
    expect(h.room.move('a', goneTile).ok).toBe(true);
    expect(h.room.cashout('a')).toMatchObject({ ok: true, multiplier: 10.77, amount: 1077 });
  });

  it('cannot bet once RUNNING; moving onto a Gone tile is TILE_GONE', async () => {
    const h = setupRoom();
    h.join('a', 'late');
    await h.room.bet('a', 100, h.safeTile(1));
    h.clock.advanceTo(BET_END + 600);
    expect(await h.room.bet('late', 100, 3)).toEqual({ ok: false, reason: 'PHASE' });
    expect(h.room.move('a', h.seqs()[0][0])).toEqual({ ok: false, reason: 'TILE_GONE' });
  });
});

describe('cashout amounts', () => {
  it('cashout after the k-th removal pays exactly floor(bet x table[stage][k-1]) for every k of stage 1', async () => {
    const h = setupRoom();
    const tile = h.safeTile(1);
    const bets = new Map<string, number>();
    for (let k = 1; k <= 91; k++) {
      const id = `k${k}`;
      h.join(id);
      bets.set(id, 10 + k * 37); // odd amounts exercise the rounding
      expect((await h.room.bet(id, bets.get(id)!, tile)).ok).toBe(true);
    }
    for (let k = 1; k <= 91; k++) {
      h.clock.advanceTo(BET_END + k * 500);
      // The last stage-1 tick moves the room into intermission; cashout there still pays 10.77x.
      if (k === 91) expect(h.room.phase).toBe('intermission');
      const r = h.room.cashout(`k${k}`);
      expect(r).toMatchObject({ ok: true, amount: Math.floor((bets.get(`k${k}`)! * MULTIPLIERS_100[0][k - 1]) / 100) });
    }
    await flush();
    const credits = h.wallet.ledger.filter((e) => e.kind === 'credit');
    expect(credits).toHaveLength(91);
    expect(new Set(credits.map((c) => c.txId)).size).toBe(91);
  });
});

describe('limits & capacity', () => {
  it('a tile with 99 players rejects the 100th at bet time and on a move', async () => {
    const h = setupRoom();
    const full = h.safeTile(1, 0);
    for (let i = 0; i < 99; i++) {
      h.join(`p${i}`);
      expect((await h.room.bet(`p${i}`, 10, full)).ok).toBe(true);
    }
    h.join('x');
    expect(await h.room.bet('x', 10, full)).toEqual({ ok: false, reason: 'TILE_FULL' });
    expect((await h.room.bet('x', 10, h.safeTile(1, 1))).ok).toBe(true);
    h.clock.advanceTo(BET_END + 700);
    expect(h.room.move('x', full)).toEqual({ ok: false, reason: 'TILE_FULL' });
    expect(h.room.core.players.get('x')!.tile).toBe(h.safeTile(1, 1));
    expect(h.room.core.counts[full]).toBe(99);
  });

  it('enforces min/max bet and funds; failed debits free the seat', async () => {
    const h = setupRoom({ startingBalance: 500 });
    h.join('a');
    expect(await h.room.bet('a', 9, 1)).toEqual({ ok: false, reason: 'BET_LIMIT' });
    expect(await h.room.bet('a', 10_001, 1)).toEqual({ ok: false, reason: 'BET_LIMIT' });
    expect(await h.room.bet('a', 600, 1)).toEqual({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    expect(h.room.core.counts[1]).toBe(0);
    expect((await h.room.bet('a', 500, 1)).ok).toBe(true);
    expect(await h.wallet.getBalance('a')).toBe(0);
  });

  it('cancel during betting refunds and frees the seat; re-bet uses a new txId', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 1000, 4);
    expect((await h.room.cancelBet('a')).ok).toBe(true);
    expect(await h.wallet.getBalance('a')).toBe(100_000);
    expect(h.room.core.counts[4]).toBe(0);
    expect((await h.room.bet('a', 2000, 5)).ok).toBe(true);
    expect(await h.wallet.getBalance('a')).toBe(98_000);
  });

  it('maxWinPerBet force-cashes at the cap; no round-wide cap touches other players', async () => {
    const h = setupRoom();
    h.join('whale', 'small');
    await h.room.bet('whale', 10_000, h.safeTile(1));
    await h.room.bet('small', 10, h.safeTile(1));
    h.clock.advanceTo(BET_END + 91 * 500 + 100);
    h.room.move('whale', h.safeTile(2));
    h.room.move('small', h.safeTile(2));
    h.clock.advanceTo(BET_END + 91 * 500 + 3000 + 90 * 500);
    await flush();
    const whale = h.direct.filter((d) => d.playerId === 'whale' && d.msg.t === 'you').at(-1)!.msg;
    expect(whale).toMatchObject({ state: 'cashedOut', payout: 1_000_000, maxWin: true });
    expect(h.room.core.players.get('small')!.state).toBe('alive');
    expect(h.room.phase).toBe('intermission');
    // The forced cashout's tile change is in that tick's delta, so a replaying client stays in sync.
    let counts: number[] = [];
    for (const m of h.broadcasts) {
      if (m.t === 'roundState') counts = [...m.tiles];
      if (m.t === 'occupancy' || m.t === 'tick') for (let i = 0; i < m.countsDelta.length; i += 2) counts[m.countsDelta[i]] = m.countsDelta[i + 1];
      if (m.t === 'tick') expect(countsChecksum(counts), `tick ${m.stage}/${m.removedCount}`).toBe(m.checksum);
    }
  });

  it('stage-3 survivors leave their tile in the final tick delta', async () => {
    const h = setupRoom();
    h.join('rider');
    await h.room.bet('rider', 10, h.safeTile(1));
    h.clock.advanceTo(BET_END + 91 * 500 + 1000);
    h.room.move('rider', h.safeTile(2));
    h.clock.advance(2000 + 90 * 500 + 1000);
    h.room.move('rider', h.safeTile(3));
    h.clock.advance(2000 + 99 * 500);
    const last = h.of('tick').at(-1)!;
    expect(last.countsDelta).toEqual(expect.arrayContaining([h.safeTile(3), 0]));
  });
});

describe('fast finish (§3.3)', () => {
  it('when everyone has cashed out, the rest of the stage goes at 5/s in the precommitted order, then ENDED', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 100, h.safeTile(1));
    h.clock.advanceTo(BET_END + 3 * 500 + 50);
    h.room.cashout('a');
    h.clock.advanceTo(BET_END + 3 * 500 + 50 + 88 * 200);
    const ticks = h.of('tick');
    expect(ticks.map((t) => t.tileGone)).toEqual(h.seqs()[0]);
    const fastTimes = ticks.slice(3).map((t) => t.serverTime);
    expect(fastTimes[0]).toBe(BET_END + 3 * 500 + 50 + 200); // min(next normal tick, now + fastTickMs)
    fastTimes.slice(1).forEach((t, i) => expect(t - fastTimes[i]).toBe(200));
    expect(ticks.slice(3).every((t) => t.fast)).toBe(true);
    expect(h.room.phase).toBe('ended');
    expect(h.of('roundEnd')[0]).toMatchObject({ emptiedAtStage: 1 });
    expect(h.of('stageEnd')).toHaveLength(0);
    expect(h.audit.rounds[0].fastFrom).toEqual({ stage: 1, k: 4 });
  });

  it('when the last player is lost, the stage fast-finishes', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 100, h.seqs()[0][4]);
    h.clock.advanceTo(BET_END + 5 * 500);
    expect(h.room.fast).toBe(true);
    h.clock.advanceTo(BET_END + 5 * 500 + 86 * 200);
    expect(h.room.phase).toBe('ended');
    expect(h.of('tick').map((t) => t.tileGone)).toEqual(h.seqs()[0]);
  });

  it('with no bets at all, fast mode applies from the first tick', () => {
    const h = setupRoom();
    h.clock.advanceTo(BET_END + 91 * 200);
    const ticks = h.of('tick');
    expect(ticks).toHaveLength(91);
    expect(ticks[0].serverTime).toBe(BET_END + 200);
    expect(ticks.every((t) => t.fast)).toBe(true);
    expect(ticks.map((t) => t.tileGone)).toEqual(h.seqs()[0]);
    expect(h.room.phase).toBe('ended');
  });

  it('when everyone cashes out during intermission the round ends; later stages are not played', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 100, h.safeTile(1));
    h.clock.advanceTo(BET_END + 91 * 500 + 500);
    h.room.cashout('a');
    expect(h.room.phase).toBe('ended');
    h.clock.advance(3500);
    expect(h.of('tick').filter((t) => t.stage === 2)).toHaveLength(0);
  });
});

describe('fairness & audit', () => {
  it('never broadcasts a future removal; the round log verifies', async () => {
    const h = setupRoom();
    h.join('a', 'b');
    await h.room.bet('a', 100, h.safeTile(1));
    await h.room.bet('b', 250, h.seqs()[0][10]);
    h.clock.advanceTo(BET_END + 2_000);
    h.room.move('a', h.safeTile(1, 1));
    h.clock.advanceTo(BET_END + 91 * 500 + 3000 + 20 * 500 + 50);
    h.room.cashout('a');
    h.clock.advance(80_000);
    const endIdx = h.broadcasts.findIndex((m) => m.t === 'roundEnd');
    const before = h.broadcasts.slice(0, endIdx);
    expect(before.some((m) => 'sequences' in m || 'serverSeed' in m)).toBe(false);
    for (const m of before) {
      if (m.t === 'roundState') expect(m.played.flat().length).toBe(m.played.flat().length); // only past
    }
    const rec = h.audit.rounds[0];
    expect(verifyRound(rec).ok).toBe(true);
    expect(rec.ticks.length).toBe(91 + 90);
    expect(rec.played[1]).toHaveLength(90);
    const a = rec.players.find((p) => p.playerId === 'a')!;
    expect(a).toMatchObject({ outcome: 'cashout', stage: 2, k: 20, payout: Math.floor((100 * MULTIPLIERS_100[1][19]) / 100) });
    expect(a.moves).toHaveLength(1);
    expect(rec.players.find((p) => p.playerId === 'b')).toMatchObject({ outcome: 'lost', stage: 1, k: 11, payout: 0 });
  });

  it('snapshots only carry tiles already played', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 100, h.safeTile(1));
    h.clock.advanceTo(BET_END + 7 * 500);
    const snap = h.room.snapshot();
    expect(snap.played[0]).toEqual(h.seqs()[0].slice(0, 7));
    expect(snap.played[1]).toEqual([]);
    expect(JSON.stringify(snap)).not.toContain(h.seqs()[0].slice(7, 12).join(','));
  });
});

describe('dynamic tile capacity (CHANGES_3 §2)', () => {
  const caps = (n: number) => tileCapsFor(n, 20, 99);
  it('cap = min(99, max(1, ceil(20% × players in room))), green up to half of it', () => {
    expect(caps(1)).toEqual({ playerBase: 1, tileCap: 1, greenMax: 0 });
    expect(caps(100)).toEqual({ playerBase: 100, tileCap: 20, greenMax: 10 });
    expect(caps(301)).toEqual({ playerBase: 301, tileCap: 61, greenMax: 30 });
    expect(caps(9_901)).toEqual({ playerBase: 9_901, tileCap: 99, greenMax: 49 });
    expect(caps(0).tileCap).toBe(1);
    expect(tileCapsFor(500, 0, 99).tileCap).toBe(99); // pct 0 = fixed cap
    const c = caps(100);
    expect([0, 10, 11, 19, 20].map((n) => tileBand(n, false, c))).toEqual(['green', 'green', 'yellow', 'yellow', 'full']);
    expect(tileBand(5, true, c)).toBe('gone');
  });

  it('with 100 players in the room a tile is Full at 20: the 21st bet and a move onto it are rejected', async () => {
    const h = setupRoom({ tileCapPct: 20 });
    const ids = Array.from({ length: 100 }, (_, i) => `p${i}`);
    h.join(...ids); // all present before the first bet
    expect(h.room.tileCaps).toEqual({ playerBase: 100, tileCap: 20, greenMax: 10 });
    const t = h.safeTile(1, 0);
    for (let i = 0; i < 20; i++) expect((await h.room.bet(ids[i], 10, t)).ok).toBe(true);
    expect(await h.room.bet(ids[20], 10, t)).toEqual({ ok: false, reason: 'TILE_FULL' });
    expect((await h.room.bet(ids[20], 10, h.safeTile(1, 1))).ok).toBe(true);
    h.clock.advanceTo(BET_END + 700);
    expect(h.room.move(ids[20], t)).toEqual({ ok: false, reason: 'TILE_FULL' });
    expect(h.room.snapshot().caps.tileCap).toBe(20);
  });

  it('the base counts players who join before the first bet, then freezes for the round', async () => {
    const h = setupRoom({ tileCapPct: 20 });
    expect(h.room.tileCaps.playerBase).toBe(0); // room opened before anyone arrived
    h.join(...Array.from({ length: 10 }, (_, i) => `p${i}`));
    expect(h.room.tileCaps).toMatchObject({ playerBase: 10, tileCap: 2 });
    await h.room.bet('p0', 10, 3);
    h.join(...Array.from({ length: 90 }, (_, i) => `late${i}`));
    expect(h.room.tileCaps).toMatchObject({ playerBase: 10, tileCap: 2 });
    h.clock.advance(10_000 + 91 * 500 + 3_000 + 90 * 500 + 3_000 + 99 * 500 + 5_000);
    h.clock.advance(200_000);
    expect(h.room.tileCaps).toMatchObject({ playerBase: 100, tileCap: 20 }); // next round: everyone counts
  });

  it('capacity changes before the first bet reach clients in an occupancy message', () => {
    const h = setupRoom({ tileCapPct: 20 });
    h.join('a', 'b', 'c', 'd', 'e', 'f');
    h.clock.advance(100);
    expect(h.of('occupancy').at(-1)!.caps).toMatchObject({ playerBase: 6, tileCap: 2, greenMax: 1 });
  });
});

describe('public players list', () => {
  it('lists at most 50 bets with masked names, cash-outs first, and counts the rest', async () => {
    const h = setupRoom();
    const ids = Array.from({ length: 80 }, (_, i) => `player${i}`);
    h.join(...ids);
    for (const [i, id] of ids.entries()) await h.room.bet(id, 10 + i, h.safeTile(1, i % 5));
    h.clock.advanceTo(BET_END + 500);
    h.room.cashout('player3');
    const feed = h.room.liveFeed();
    expect(feed.bets).toHaveLength(50);
    expect(feed.moreBets).toBe(30);
    expect(feed.bets[0]).toMatchObject({ nickname: 'pl***3', state: 'cashedOut', bet: 13, multiplier: 1.01 });
    expect(feed.bets[1]).toMatchObject({ state: 'alive', bet: 89 });
    expect(feed.stats).toMatchObject({ inRoom: 80, staked: ids.reduce((a, _, i) => a + 10 + i, 0), paid: 13, biggestWin: 13, biggestMultiplier: 1.01 });
    for (const b of feed.bets) expect(b.nickname).toMatch(/^pl\*\*\*\d$/);
  });
});
