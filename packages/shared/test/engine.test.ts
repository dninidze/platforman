import { describe, expect, it } from 'vitest';
import { FakeClock, MULTIPLIERS_100, RoundCore, deriveSequences, payout, type EngineLimits } from '../src';

const LIMITS: EngineLimits = { tileCapacity: 99, minBet: 10, maxBet: 10_000, maxWinPerBet: 1_000_000 };
const SEQS = deriveSequences('aa'.repeat(32), 'engine:1');

function core(limits = LIMITS) {
  return new RoundCore(SEQS, limits);
}
/** A tile that survives the whole stage. */
const survivorTile = (stage: number) => [...Array(100).keys()].find((t) => !SEQS[stage - 1].includes(t))!;

describe('RoundCore', () => {
  it('bets, cancels and moves during betting', () => {
    const c = core();
    expect(c.placeBet('a', 100, 5).ok).toBe(true);
    expect(c.placeBet('a', 100, 6)).toEqual({ ok: false, reason: 'PHASE' });
    expect(c.placeBet('b', 5, 6)).toEqual({ ok: false, reason: 'BET_LIMIT' });
    expect(c.placeBet('b', 10_001, 6)).toEqual({ ok: false, reason: 'BET_LIMIT' });
    expect(c.move('a', 7).ok).toBe(true);
    expect(c.counts[5]).toBe(0);
    expect(c.counts[7]).toBe(1);
    expect(c.cancelBet('a').ok).toBe(true);
    expect(c.counts[7]).toBe(0);
    expect(c.onBoard).toBe(0);
  });

  it('rejects the 100th entrant to a tile at bet time and on a move', () => {
    const c = core();
    for (let i = 0; i < 99; i++) expect(c.placeBet(`p${i}`, 10, 0).ok).toBe(true);
    expect(c.placeBet('late', 10, 0)).toEqual({ ok: false, reason: 'TILE_FULL' });
    expect(c.placeBet('late', 10, 1).ok).toBe(true);
    expect(c.move('late', 0)).toEqual({ ok: false, reason: 'TILE_FULL' });
    expect(c.players.get('late')!.tile).toBe(1);
  });

  it('cashout is disabled before tile 1 of stage 1 and pays floor(bet x table[k-1]) after', () => {
    const c = core();
    const t = survivorTile(1);
    c.placeBet('a', 333, t);
    c.startRunning();
    expect(c.cashout('a')).toEqual({ ok: false, reason: 'PHASE' });
    for (let k = 1; k <= 37; k++) c.tick();
    const r = c.cashout('a');
    expect(r.ok).toBe(true);
    expect(c.players.get('a')!.payout).toBe(Math.floor((333 * MULTIPLIERS_100[0][36]) / 100));
    expect(c.cashout('a')).toEqual({ ok: false, reason: 'PHASE' });
  });

  it('loses players whose tile goes and reports TOO_LATE for their cashout', () => {
    const c = core();
    const first = SEQS[0][0];
    c.placeBet('a', 100, first);
    c.startRunning();
    const r = c.tick();
    expect(r.tile).toBe(first);
    expect(r.losers.map((p) => p.id)).toEqual(['a']);
    expect(c.cashout('a')).toEqual({ ok: false, reason: 'TOO_LATE' });
    expect(c.move('a', survivorTile(1))).toEqual({ ok: false, reason: 'TOO_LATE' });
    expect(c.onBoard).toBe(0);
  });

  it('plays three stages, resurrects tiles and pays survivors the top multiplier (10,778x)', () => {
    const c = core();
    c.placeBet('rider', 10, survivorTile(1));
    c.startRunning();
    for (let s = 1; s <= 3; s++) {
      // Move to a tile that survives this stage (allowed in intermission and while running).
      const r = c.move('rider', survivorTile(s));
      expect(r.ok).toBe(true);
      let last;
      do last = c.tick();
      while (!last.stageComplete);
      expect(last.k).toBe([91, 90, 99][s - 1]);
      if (s < 3) {
        expect(c.phase).toBe('intermission');
        expect(c.cashoutOpen).toBe(true);
        c.startNextStage();
        expect([...c.gone].every((g) => g === 0)).toBe(true);
      } else {
        expect(last.survivors.map((p) => p.id)).toEqual(['rider']);
      }
    }
    expect(c.phase).toBe('ended');
    const p = c.players.get('rider')!;
    expect(p.payout).toBe(payout(10, MULTIPLIERS_100[2][98])); // 10 cents x 10,778
    expect(p.outcome).toBe('survived');
    expect(c.emptiedAtStage).toBeNull();
  });

  it('force-cashes at maxWinPerBet when bet x multiplier reaches the cap', () => {
    const c = core();
    c.placeBet('whale', 10_000, survivorTile(1));
    c.placeBet('minnow', 10, survivorTile(1));
    c.startRunning();
    while (!c.tick().stageComplete);
    c.startNextStage();
    c.move('whale', survivorTile(2));
    c.move('minnow', survivorTile(2));
    let forcedAt = -1;
    for (;;) {
      const r = c.tick();
      if (r.forced.length) {
        forcedAt = r.k;
        expect(r.forced.map((p) => p.id)).toEqual(['whale']);
      }
      if (r.stageComplete) break;
    }
    // 100.00 EUR x 107 >= 10,000 EUR only on the last stage-2 tile (97.98x one tile before).
    expect(forcedAt).toBe(90);
    const w = c.players.get('whale')!;
    expect(w.payout).toBe(1_000_000);
    expect(w.outcome).toBe('maxWin');
    expect(c.players.get('minnow')!.state).toBe('alive');
  });

  it('records the stage where the board emptied', () => {
    const c = core();
    c.placeBet('a', 10, survivorTile(1));
    c.startRunning();
    c.tick();
    c.cashout('a');
    expect(c.onBoard).toBe(0);
    while (!c.tick().stageComplete);
    c.end();
    expect(c.emptiedAtStage).toBe(1);
    expect(c.played[0]).toEqual(SEQS[0]);
  });

  it('potentialWin follows the current multiplier', () => {
    const c = core();
    c.placeBet('a', 250, survivorTile(1));
    c.startRunning();
    c.tick();
    c.tick();
    expect(c.potentialWin(c.players.get('a')!)).toBe(payout(250, MULTIPLIERS_100[0][1]));
  });
});

describe('FakeClock', () => {
  it('fires timers in time order, ties in creation order', () => {
    const clock = new FakeClock(0);
    const log: string[] = [];
    clock.setTimeout(() => log.push('b@20'), 20);
    clock.setTimeout(() => log.push('a@10'), 10);
    clock.setTimeout(() => log.push('c@10'), 10);
    const iv = clock.setInterval(() => log.push(`i@${clock.now()}`), 15);
    clock.advance(31);
    clock.clearInterval(iv);
    clock.advance(100);
    expect(log).toEqual(['a@10', 'c@10', 'i@15', 'b@20', 'i@30']);
    expect(clock.now()).toBe(131);
  });
});
