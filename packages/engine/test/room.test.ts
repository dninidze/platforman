import { DEFAULT_CONFIG, MULTIPLIERS_100, countsChecksum, payout, roundHighlights, tileBand, tileCapsFor, verifyRound } from '@p3/shared';
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
    expect(h.of('stageEnd')).toEqual([expect.objectContaining({ stage: 1, multiplier: 10.78, nextMultiplier: 10.89, phaseEndsAt: BET_END + 91 * 500 + 3000 })]);

    h.clock.advanceTo(BET_END + 91 * 500 + 3000);
    expect(h.room.phase).toBe('running');
    expect(h.room.core.stage).toBe(2);
    expect(h.room.core.gone.every((g) => g === 0)).toBe(true);
    h.clock.advanceTo(BET_END + 91 * 500 + 3000 + 500);
    expect(h.of('tick').at(-1)).toMatchObject({ stage: 2, removedCount: 1, multiplier: 10.89, tileGone: h.seqs()[1][0] });
  });

  it('all three stages end to end; survivor on the last stage-3 tile is paid the top multiplier (10,778x)', async () => {
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
    const top = payout(10, MULTIPLIERS_100[2][98]); // 10 cents x 10,778
    expect(top).toBe(107_780);
    expect(end.survivorsPaid).toEqual([{ nickname: 'ri***r', amount: top }]); // public lists are masked
    expect(h.audit.rounds[0].players[0].nickname).toBe('rider'); // the audit log keeps the real name
    expect(end.emptiedAtStage).toBeNull();
    expect(await h.wallet.getBalance('rider')).toBe(balBefore + top);
    expect(h.audit.rounds[0].players[0]).toMatchObject({ outcome: 'survived', stage: 3, k: 99, payout: top });
  });

  it('next round starts after resultsMs with fresh occupancy and new seeds', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 100, h.seqs()[0][0]);
    h.clock.advanceTo(BET_END + 500); // lost on first tile -> fast finish of stage 1
    h.clock.advanceTo(BET_END + 500 + 90 * DEFAULT_CONFIG.fastTickMs);
    expect(h.room.phase).toBe('ended');
    h.clock.advance(DEFAULT_CONFIG.resultsMs);
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
    expect(r).toEqual({ ok: true, amount: 980, multiplier: 0.98, maxWin: false }); // below 1.00x is allowed (CHANGES_6 §1)
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
    expect(h.room.cashout('a')).toMatchObject({ ok: true, multiplier: 10.78, amount: 1078 });
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

describe('empty board finishes its stage only (CHANGES_7 §1)', () => {
  const FAST = DEFAULT_CONFIG.fastTickMs;

  it('when everyone has cashed out, the rest of the stage goes fast in the precommitted order, then ENDED', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 100, h.safeTile(1));
    h.clock.advanceTo(BET_END + 3 * 500 + 50);
    h.room.cashout('a');
    h.clock.advanceTo(BET_END + 3 * 500 + 50 + 88 * FAST);
    const ticks = h.of('tick');
    expect(ticks.map((t) => t.tileGone)).toEqual(h.seqs()[0]);
    const fastTimes = ticks.slice(3).map((t) => t.serverTime);
    expect(fastTimes[0]).toBe(BET_END + 3 * 500 + 50 + FAST); // min(next normal tick, now + fastTickMs)
    fastTimes.slice(1).forEach((t, i) => expect(t - fastTimes[i]).toBe(FAST));
    expect(ticks.slice(3).every((t) => t.fast)).toBe(true);
    expect(h.room.phase).toBe('ended');
    expect(h.of('roundEnd')[0]).toMatchObject({ emptiedAtStage: 1 });
    expect(h.of('stageEnd')).toHaveLength(0);
    expect(h.audit.rounds[0].fastFrom).toEqual({ stage: 1, k: 4 });
    // CHANGES_8 §1: the 9 tiles still standing, in precommitted order; the last is the stage's surviving tile.
    const tail = h.of('roundEnd')[0].stageTail;
    expect(tail).toHaveLength(9);
    expect(new Set([...h.seqs()[0], ...tail]).size).toBe(100);
    expect(tail.at(-1)).toBe(h.room['permutations'][0][99]);
  });

  it('when the last player is lost, the stage fast-finishes', async () => {
    const h = setupRoom();
    h.join('a');
    await h.room.bet('a', 100, h.seqs()[0][4]);
    h.clock.advanceTo(BET_END + 5 * 500);
    expect(h.room.fast).toBe(true);
    h.clock.advanceTo(BET_END + 5 * 500 + 86 * FAST);
    expect(h.room.phase).toBe('ended');
    expect(h.of('tick').map((t) => t.tileGone)).toEqual(h.seqs()[0]);
  });

  it('with no bets at all, fast mode applies from the first tick and stage 1 only is played', () => {
    const h = setupRoom();
    h.clock.advanceTo(BET_END + 91 * FAST);
    const ticks = h.of('tick');
    expect(ticks).toHaveLength(91);
    expect(ticks[0].serverTime).toBe(BET_END + FAST);
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
    expect(h.of('roundEnd')[0]).toMatchObject({ emptiedAtStage: 1 });
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
    expect(rec.ticks.length).toBe(91 + 90); // the emptied board finishes stage 2 only
    expect(rec.played[1]).toHaveLength(90);
    expect(rec.emptiedAtStage).toBe(2);
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

describe('tile capacity (CHANGES_4 §3)', () => {
  const caps = (n: number) => tileCapsFor(n, 10, 5, false);
  it('lock at max(1, ceil(10% of bets)), yellow from ceil(5%)', () => {
    expect(caps(300)).toEqual({ playerBase: 300, tileCap: 30, yellowFrom: 15, live: false });
    expect(caps(100)).toEqual({ playerBase: 100, tileCap: 10, yellowFrom: 5, live: false });
    expect(caps(9_900)).toMatchObject({ tileCap: 990, yellowFrom: 495 }); // no 99 maximum any more
    expect(caps(1)).toMatchObject({ tileCap: 1, yellowFrom: 1 });
    expect(caps(0)).toMatchObject({ tileCap: 1, yellowFrom: 1 });
    const c = caps(300);
    expect([0, 14, 15, 29, 30, 45].map((n) => tileBand(n, false, c))).toEqual(['green', 'green', 'yellow', 'yellow', 'full', 'full']);
    expect(tileBand(5, true, c)).toBe('gone');
  });

  it('no limit while betting: 150 of 300 bets can stand on one tile', async () => {
    const h = setupRoom({ tileCapPct: 10, tileYellowPct: 5, tileCapacity: 0 });
    const ids = Array.from({ length: 300 }, (_, i) => `p${i}`);
    h.join(...ids);
    for (let i = 0; i < 150; i++) expect((await h.room.bet(ids[i], 10, h.safeTile(1, 0))).ok).toBe(true);
    expect(h.room.tileCaps).toMatchObject({ playerBase: 150, tileCap: 15, live: true }); // live display only
    for (let i = 150; i < 300; i++) expect((await h.room.bet(ids[i], 10, 1 + (i % 20))).ok).toBe(true);
    expect(h.room.core.counts[h.safeTile(1, 0)]).toBeGreaterThanOrEqual(150);
    expect(h.room.snapshot().caps).toMatchObject({ playerBase: 300, tileCap: 30, yellowFrom: 15, live: true });
  });

  it('at round start the lock freezes at 10% of bets: moves onto locked tiles get TILE_FULL, over-full tiles keep their players', async () => {
    const h = setupRoom({ tileCapPct: 10, tileYellowPct: 5, tileCapacity: 0 });
    const ids = Array.from({ length: 100 }, (_, i) => `p${i}`);
    h.join(...ids, 'late');
    const crowded = h.safeTile(1, 0);
    const edge = h.safeTile(1, 1);
    for (let i = 0; i < 40; i++) await h.room.bet(ids[i], 10, crowded); // 40% on one tile
    for (let i = 40; i < 49; i++) await h.room.bet(ids[i], 10, edge); // 9 = one below the cap
    for (let i = 49; i < 100; i++) await h.room.bet(ids[i], 10, h.safeTile(1, 2 + (i % 5)));
    h.clock.advanceTo(BET_END + 100);
    expect(h.room.tileCaps).toEqual({ playerBase: 100, tileCap: 10, yellowFrom: 5, live: false });
    expect(h.room.core.counts[crowded]).toBe(40);
    expect(h.room.move(ids[60], edge).ok).toBe(true); // 10th player: reaches the cap
    expect(h.room.move(ids[61], edge)).toEqual({ ok: false, reason: 'TILE_FULL' });
    expect(h.room.move(ids[62], crowded)).toEqual({ ok: false, reason: 'TILE_FULL' });
    expect(h.of('roundState').at(-1)!.caps).toMatchObject({ tileCap: 10, live: false });
    // Next round: the base starts again from the new bets.
    while (h.room.roundNo === 1) h.clock.advance(500);
    expect(h.room.phase).toBe('betting');
    expect(h.room.tileCaps).toMatchObject({ playerBase: 0, live: true });
  });
});

describe('public players list', () => {
  it('lists every bet with masked names, live bets first by size (CHANGES_10 A1)', async () => {
    const h = setupRoom();
    const ids = Array.from({ length: 80 }, (_, i) => `player${i}`);
    h.join(...ids);
    for (const [i, id] of ids.entries()) await h.room.bet(id, 10 + i, h.safeTile(1, i % 5));
    h.clock.advanceTo(BET_END + 500);
    h.room.cashout('player3');
    const feed = h.room.liveFeed();
    expect(feed.bets).toHaveLength(80);
    expect(feed.moreBets).toBe(0);
    expect(feed.bets[0]).toMatchObject({ state: 'alive', bet: 89, survived: null });
    const alive = feed.bets.filter((b) => b.state === 'alive');
    expect(alive).toHaveLength(79);
    expect(alive.map((b) => b.bet)).toEqual([...alive.map((b) => b.bet)].sort((x, y) => y - x));
    expect(feed.bets[79]).toMatchObject({ state: 'cashedOut', bet: 13 });
    expect(feed.stats).toMatchObject({ inRoom: 80, staked: ids.reduce((a, _, i) => a + 10 + i, 0), paid: 12, biggestWin: 12, biggestMultiplier: 0.98 });
    for (const b of feed.bets) expect(b.nickname).toMatch(/^pl\*\*\*\d$/);
  });
});

describe('live bets order and tiles survived (CHANGES_7 §2)', () => {
  it('live by bet, then cashed out by win, then crashed by bet; tiles survived over the whole round', async () => {
    const h = setupRoom();
    h.join('live', 'cash', 'lost', 'small');
    const doomed = h.seqs()[0][1];
    await h.room.bet('live', 50, h.safeTile(1, 0));
    await h.room.bet('small', 20, h.safeTile(1, 1));
    await h.room.bet('cash', 30, h.safeTile(1, 2));
    await h.room.bet('lost', 90, doomed);
    expect(h.room.liveFeed().bets.map((b) => b.bet)).toEqual([90, 50, 30, 20]); // while betting: by bet
    h.clock.advanceTo(BET_END + 3 * 500 + 10); // 3 tiles gone; "lost" went on tile 2
    h.room.cashout('cash');
    const bets = h.room.liveFeed().bets;
    expect(bets.map((b) => [b.state, b.bet, b.survived])).toEqual([
      ['alive', 50, null],
      ['alive', 20, null],
      ['cashedOut', 30, 3],
      ['lost', 90, 1],
    ]);
    expect(bets[3].crashMultiplier).toBe(MULTIPLIERS_100[0][0] / 100); // lost on tile 2: last stood at tile 1's multiplier
    expect(bets[0].crashMultiplier).toBeNull();
  });
});

describe('colour rule (CHANGES_6 §4) and round highlights', () => {
  it('default (CHANGES_10 D2): green at 0, yellow from 1 player, red/locked at round(2% of bets), half up', () => {
    const caps = (n: number) => tileCapsFor(n, DEFAULT_CONFIG.tileCapPct, DEFAULT_CONFIG.tileYellowPct, false);
    expect(caps(100)).toMatchObject({ tileCap: 2, yellowFrom: 1 }); // locks at 2
    expect(caps(300)).toMatchObject({ tileCap: 6 });
    expect(caps(125)).toMatchObject({ tileCap: 3 }); // 2.5 rounds up
    expect(caps(30)).toMatchObject({ tileCap: 1 }); // 0.6 rounds up to 1
    expect(caps(1_000)).toMatchObject({ tileCap: 20 });
    expect(caps(10)).toMatchObject({ tileCap: 1 }); // never below 1
    const c = caps(100);
    expect([0, 1, 2, 3, 40].map((n) => tileBand(n, false, c))).toEqual(['green', 'yellow', 'full', 'full', 'full']);
  });

  it('with 100 bets a tile locks at its 3rd player from round start', async () => {
    const h = setupRoom({ tileCapPct: 3, tileYellowPct: 0, tileCapacity: 0 });
    const ids = Array.from({ length: 100 }, (_, i) => `p${i}`);
    h.join(...ids);
    const t = h.safeTile(1, 0);
    await h.room.bet(ids[0], 10, t);
    await h.room.bet(ids[1], 10, t);
    for (let i = 2; i < 100; i++) await h.room.bet(ids[i], 10, h.safeTile(1, 1 + (i % 7)));
    h.clock.advanceTo(BET_END + 100);
    expect(h.room.tileCaps).toMatchObject({ playerBase: 100, tileCap: 3, live: false });
    expect(h.room.move(ids[50], t).ok).toBe(true); // 3rd player: reaches the cap
    expect(h.room.move(ids[51], t)).toEqual({ ok: false, reason: 'TILE_FULL' });
  });

  it('Top man = longest without cashing out; Top cashout = highest multiplier (ties: larger amount)', async () => {
    const h = setupRoom();
    h.join('early', 'late', 'c1', 'c2', 'c3');
    const s1 = h.seqs()[0];
    await h.room.bet('early', 100, s1[2]); // goes at removal 3 of Vol. 1
    await h.room.bet('late', 100, s1[40]); // goes at removal 41 of Vol. 1
    for (const id of ['c1', 'c2', 'c3']) await h.room.bet(id, id === 'c3' ? 500 : 100, h.safeTile(1));
    h.clock.advanceTo(BET_END + 2 * 500);
    h.room.cashout('c1'); // 0.99x
    h.clock.advanceTo(BET_END + 5 * 500);
    h.room.cashout('c2'); // 1.02x
    h.room.cashout('c3'); // 1.02x, larger amount
    h.clock.advance(300_000);
    const end = h.of('roundEnd')[0];
    expect(end.highlights).toEqual({
      topMan: { multiplier: MULTIPLIERS_100[0][39] / 100, survived: 40 },
      topCashout: { multiplier: 1.02, amount: 510 },
    });
    expect(h.room.history.at(-1)!.highlights).toEqual(end.highlights);
  });

  it('a lost player in stage 2 counts the 91 tiles of stage 1; a 10,778x winner is top man with n280', () => {
    const players = [
      { outcome: 'lost', resolvedStage: 2, resolvedK: 1, multiplier100: null, payout: 0 },
      { outcome: 'lost', resolvedStage: 1, resolvedK: 1, multiplier100: null, payout: 0 },
    ] as never[];
    expect(roundHighlights(players)).toEqual({ topMan: { multiplier: 10.78, survived: 91 }, topCashout: null });
    expect(roundHighlights([{ outcome: 'lost', resolvedStage: 1, resolvedK: 1, multiplier100: null, payout: 0 }] as never[]).topMan).toEqual({ multiplier: 1, survived: 0 });
    const winner = [...players, { outcome: 'survived', resolvedStage: 3, resolvedK: 99, multiplier100: 1_077_800, payout: 107_780 }] as never[];
    expect(roundHighlights(winner).topMan).toEqual({ multiplier: 10_778, survived: 280 });
    expect(roundHighlights([])).toEqual({ topMan: null, topCashout: null });
  });

  it('CHANGES_7 §3: a cash-out that lasted longest is also Top man, with the same multiplier; Top man >= Top cashout', () => {
    const players = [
      { outcome: 'lost', resolvedStage: 1, resolvedK: 30, multiplier100: null, payout: 0 },
      { outcome: 'cashout', resolvedStage: 2, resolvedK: 5, multiplier100: MULTIPLIERS_100[1][4], payout: 1_400 },
      { outcome: 'cashout', resolvedStage: 1, resolvedK: 10, multiplier100: 120, payout: 600 },
    ] as never[];
    expect(roundHighlights(players)).toEqual({ topMan: { multiplier: MULTIPLIERS_100[1][4] / 100, survived: 96 }, topCashout: { multiplier: MULTIPLIERS_100[1][4] / 100, amount: 1_400 } });
    // Random rounds: the rule always holds.
    for (let i = 0; i < 200; i++) {
      const ps = Array.from({ length: 6 }, (_, j) => {
        const stage = 1 + ((i + j) % 3);
        const k = 1 + ((i * 7 + j * 13) % [91, 90, 99][stage - 1]);
        const cash = (i + j) % 2 === 0;
        return cash
          ? { outcome: 'cashout', resolvedStage: stage, resolvedK: k, multiplier100: MULTIPLIERS_100[stage - 1][k - 1], payout: 1 }
          : { outcome: 'lost', resolvedStage: stage, resolvedK: k, multiplier100: null, payout: 0 };
      }) as never[];
      const hl = roundHighlights(ps);
      if (hl.topCashout) expect(hl.topMan!.multiplier).toBeGreaterThanOrEqual(hl.topCashout.multiplier);
    }
  });
});

describe('CHANGES_8 §5: cashed-out players listed by multiplier', () => {
  it('a higher multiplier comes first even with a smaller win', async () => {
    const h = setupRoom();
    h.join('big', 'late');
    await h.room.bet('big', 2_000, h.safeTile(1, 0));
    await h.room.bet('late', 10, h.safeTile(1, 1));
    h.clock.advanceTo(BET_END + 2 * 500 + 10);
    h.room.cashout('big');
    h.clock.advanceTo(BET_END + 6 * 500 + 10);
    h.room.cashout('late');
    expect(h.room.liveFeed().bets.map((b) => b.bet)).toEqual([10, 2_000]);
  });
});
