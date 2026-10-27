import { DEFAULT_CONFIG, FakeClock, type GameConfig } from '@p3/shared';
import { describe, expect, it } from 'vitest';
import { MemoryAuditLog } from '../src/audit';
import { RoomManager } from '../src/roomManager';
import { MockWallet } from '../src/wallet';

function setup(over: Partial<GameConfig> = {}) {
  const clock = new FakeClock(0);
  const config = { ...DEFAULT_CONFIG, ...over };
  const audit = new MemoryAuditLog();
  const mgr = new RoomManager({
    config,
    clock,
    audit,
    wallet: new MockWallet(config.startingBalance),
    sink: { broadcast: () => {}, sendToPlayer: () => {} },
  });
  return { clock, mgr, audit };
}

describe('RoomManager', () => {
  it('starts with one room and fills the fullest open room below roomSoftCap', () => {
    const { mgr } = setup({ roomSoftCap: 3 });
    expect(mgr.list()).toHaveLength(1);
    const rooms = ['a', 'b', 'c'].map((p) => mgr.join(p, p).id);
    expect(new Set(rooms)).toEqual(new Set(['EUR-1']));
    // Passing the soft cap opens a new room and new joiners go there.
    expect(mgr.join('d', 'd').id).toBe('EUR-2');
    expect(mgr.join('e', 'e').id).toBe('EUR-2');
    // A leaver frees a seat in room 1; with a 2/2 tie the first room wins, then room 2 is the only open one.
    mgr.leave('a');
    expect(mgr.join('f', 'f').id).toBe('EUR-1');
    expect(mgr.join('g', 'g').id).toBe('EUR-2');
    expect(mgr.list().map((r) => r.players)).toEqual([3, 3]);
    expect(mgr.join('h', 'h').id).toBe('EUR-3');
  });

  it('re-joining returns the same room', () => {
    const { mgr } = setup({ roomSoftCap: 1 });
    const r1 = mgr.join('a', 'a');
    expect(mgr.join('a', 'a')).toBe(r1);
  });

  it('closes an empty extra room after 3 consecutive empty rounds and always keeps one', () => {
    const { clock, mgr, audit } = setup({ roomSoftCap: 1, bettingMs: 1_000 });
    mgr.join('a', 'a');
    mgr.join('b', 'b'); // opens EUR-2
    expect(mgr.list().map((r) => r.roomId)).toEqual(['EUR-1', 'EUR-2']);
    mgr.leave('b');
    // An empty round: 1 s betting + 91 fast ticks at 200 ms + 4 s results.
    const roundMs = 1_000 + 91 * 200 + 4_000;
    clock.advance(roundMs * 2);
    expect(mgr.rooms.has('EUR-2')).toBe(true);
    clock.advance(roundMs * 2);
    expect(mgr.rooms.has('EUR-2')).toBe(false);
    expect(audit.events.some((e) => e.kind === 'room_closed')).toBe(true);
    mgr.leave('a');
    clock.advance(roundMs * 10);
    expect(mgr.list().map((r) => r.roomId)).toEqual(['EUR-1']);
  });

  it('rooms run independent timelines and seeds', () => {
    const { clock, mgr } = setup({ roomSoftCap: 1 });
    mgr.join('a', 'a');
    clock.advance(3_000);
    const r2 = mgr.join('b', 'b');
    const r1 = mgr.get('EUR-1')!;
    expect(r1.snapshot().serverSeedHash).not.toBe(r2.snapshot().serverSeedHash);
    expect(r1.phaseEndsAt).not.toBe(r2.phaseEndsAt);
  });
});
