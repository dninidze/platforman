import { FakeClock, countsChecksum, decodeGoneMask, type ServerMessage } from '@p3/shared';
import { describe, expect, it } from 'vitest';
import { LocalHost } from '../src/host';
import { checkRecord } from '../src/verifyLog';
import { flush, SEED } from './helpers';

/** xorshift32 so bot behaviour is reproducible in tests. */
function rng(seed = 7) {
  let x = seed;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

function setup(settings: { bots?: number; busyServer?: boolean; roomSoftCap?: number } = {}) {
  const clock = new FakeClock(0);
  const host = new LocalHost({ clock, settings: { bots: 0, ...settings }, rng: rng(), seedSource: () => SEED, statsMs: 1_000 });
  const client = () => {
    const msgs: ServerMessage[] = [];
    const ep = host.connect((m) => msgs.push(structuredClone(m)));
    return { msgs, ep, of: <T extends ServerMessage['t']>(t: T) => msgs.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t) };
  };
  /** Advance in small steps, letting wallet promises settle in between. */
  const run = async (ms: number, step = 50) => {
    for (let t = 0; t < ms; t += step) {
      clock.advance(step);
      await flush();
    }
  };
  return { clock, host, client, run };
}

/** Rebuild the board the way the UI does and check every tick's checksum. */
function replay(msgs: ServerMessage[]) {
  let counts: number[] = [];
  let checked = 0;
  let mismatches = 0;
  let maxCount = 0;
  for (const m of msgs) {
    if (m.t === 'roundState') counts = [...m.tiles];
    if (m.t === 'occupancy' || m.t === 'tick') {
      for (let i = 0; i < m.countsDelta.length; i += 2) counts[m.countsDelta[i]] = m.countsDelta[i + 1];
      maxCount = Math.max(maxCount, ...counts);
    }
    if (m.t === 'tick') {
      checked++;
      if (countsChecksum(counts) !== m.checksum) mismatches++;
    }
  }
  return { checked, mismatches, maxCount };
}

describe('LocalHost (in-page engine)', () => {
  it('9,900 bots: the client-side board matches the engine on every tick; capacity holds', async () => {
    const h = setup({ bots: 9_900 });
    const a = h.client();
    const b = h.client();
    a.ep.receive({ t: 'join', nickname: 'alice' });
    b.ep.receive({ t: 'join', nickname: 'bob' });
    await flush();
    const room = h.host.manager.get('EUR-1')!;
    expect(room.members.size).toBe(9_902);
    await h.run(10_000 + 91 * 500 + 3_000 + 20 * 500);
    const ra = replay(a.msgs);
    const rb = replay(b.msgs);
    expect(ra.checked).toBeGreaterThan(90);
    expect(ra.mismatches).toBe(0);
    expect(rb.mismatches).toBe(0);
    expect(ra.maxCount).toBeLessThanOrEqual(99);
    // Both connections saw the same removals and multipliers.
    const ticks = (msgs: ServerMessage[]) => msgs.filter((m) => m.t === 'tick').map((m) => m.t === 'tick' && [m.tileGone, m.multiplier]);
    expect(ticks(a.msgs)).toEqual(ticks(b.msgs));
    // Bots really played: thousands of bets, cashouts, rejections for full tiles.
    expect(h.host.audit.rejectCounts.TILE_FULL ?? 0).toBeGreaterThan(0);
    const feed = a.of('liveFeed').at(-1)!;
    expect(feed.totals.players).toBeGreaterThan(9_000);
    expect(feed.totals.cashedOut).toBeGreaterThan(0);
  }, 120_000);

  it('seeds a persisted balance once and resets it on request', async () => {
    const h = setup();
    const c = h.client();
    c.ep.receive({ t: 'join', nickname: 'saver', balance: 4_321 });
    await flush();
    expect(c.of('welcome')[0].balance).toBe(4_321);
    c.ep.receive({ t: 'resetBalance' });
    await flush();
    expect(c.of('balance')[0].balance).toBe(100_000);
    expect(await h.host.wallet.getBalance('p:saver')).toBe(100_000);
    // A second join in the same host lifetime does not overwrite the live balance.
    const c2 = h.client();
    c2.ep.receive({ t: 'join', nickname: 'saver', balance: 1 });
    await flush();
    expect(c2.of('welcome')[0].balance).toBe(100_000);
  });

  it('"simulate busy server" opens more rooms once bots pass roomSoftCap; off puts everyone back in one', async () => {
    const h = setup({ bots: 2_500 });
    const c = h.client();
    c.ep.receive({ t: 'join', nickname: 'me' });
    await flush();
    expect(h.host.manager.list().map((r) => r.players)).toEqual([2_501]);
    c.ep.receive({ t: 'settings', busyServer: true, roomSoftCap: 2_000 });
    await flush();
    const busy = h.host.manager.list();
    expect(busy.length).toBe(2);
    expect(busy[0]).toMatchObject({ roomId: 'EUR-1', players: 2_000 });
    expect(busy[1].players).toBe(501);
    expect(c.of('rooms').at(-1)!.rooms).toHaveLength(2);
    expect(h.host.manager.roomOf('p:me')!.id).toBe('EUR-1');
    c.ep.receive({ t: 'settings', busyServer: false });
    await flush();
    expect(h.host.manager.get('EUR-1')!.members.size).toBe(2_501);
    // The emptied room closes after three empty rounds.
    await h.run(3 * 40_000, 200);
    expect(h.host.manager.list()).toHaveLength(1);
  }, 60_000);

  it('bot count is adjustable from 0 to 9,900', async () => {
    const h = setup({ bots: 300 });
    expect(h.host.bots.count).toBe(300);
    h.host.applySettings({ bots: 50_000 });
    expect(h.host.bots.count).toBe(9_900);
    h.host.applySettings({ bots: 0 });
    expect(h.host.bots.count).toBe(0);
    expect(h.host.manager.get('EUR-1')!.members.size).toBe(0);
  });

  it('logs rounds that verify, and serves them by id and as JSONL', async () => {
    const h = setup({ bots: 200 });
    const c = h.client();
    c.ep.receive({ t: 'join', nickname: 'auditor' });
    await h.run(200_000, 100);
    expect(h.host.audit.rounds.length).toBeGreaterThan(0);
    for (const rec of h.host.audit.rounds) expect(checkRecord(rec)).toEqual([]);
    const id = h.host.audit.rounds[0].roundId;
    c.ep.receive({ t: 'getRound', roundId: id });
    c.ep.receive({ t: 'getLog' });
    await flush();
    expect(c.of('roundRecord')[0].record!.serverSeed).toBe(SEED);
    expect(c.of('log')[0].jsonl.trim().split('\n')).toHaveLength(h.host.audit.rounds.length);
    // The client never received an unrevealed sequence: only roundEnd carries sequences.
    const roundEnds = new Set(c.of('roundEnd').map((m) => m.roundId));
    for (const m of c.msgs) if ('sequences' in m) expect(m.t === 'roundEnd' && roundEnds.has(m.roundId)).toBe(true);
    // Snapshots only show tiles already gone.
    for (const s of c.of('roundState')) expect(decodeGoneMask(s.goneMask).filter(Boolean).length).toBe(s.phase === 'intermission' ? 0 : s.removedCount);
  }, 60_000);

  it('rate-limits moves to 5/s and rejects actions before join', async () => {
    const h = setup();
    const c = h.client();
    c.ep.receive({ t: 'cashout' });
    await flush();
    expect(c.of('error')[0]).toMatchObject({ code: 'NOT_JOINED' });
    c.ep.receive({ t: 'join', nickname: 'mover' });
    await flush();
    c.ep.receive({ t: 'bet', amount: 100, tileId: 0 });
    await flush();
    for (let i = 0; i < 12; i++) c.ep.receive({ t: 'move', tileId: 1 + i });
    await flush();
    const res = c.of('moveResult');
    expect(res.filter((r) => r.ok)).toHaveLength(5);
    expect(res.filter((r) => r.reason === 'RATE_LIMIT')).toHaveLength(7);
  });

  it('pushes host stats with tick lateness', async () => {
    const h = setup({ bots: 100 });
    const c = h.client();
    await h.run(15_000);
    const s = c.of('hostStats').at(-1)!;
    expect(s.bots).toBe(100);
    expect(s.tickLateness.n).toBeGreaterThan(0);
    expect(s.tickLateness.max).toBe(0); // fake clock: ticks fire exactly on time
  });
});
