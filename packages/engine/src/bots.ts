import { STAGE_REMOVALS, TILE_COUNT, generateDisplayName, type BroadcastMessage, type Clock, type GameConfig, type Stage } from '@p3/shared';
import type { Room } from './room';
import type { RoomManager } from './roomManager';

/**
 * Simulated players for the in-page room. Bots are ordinary room members that act through the same
 * Room API as the human (bet / move / cashout), so they hit the same limits, locks and capacity
 * rules. They only look at public state (tile counts, Gone tiles, phase) and their own bet: never at
 * the removal sequence.
 */

interface Bot {
  id: string;
  nickname: string;
  roomId: string;
  target: { stage: Stage; k: number };
}

/** Tile popularity: corners, centre and "lucky numbers" draw crowds (tile numbers are 1-based in the UI). */
export const TILE_WEIGHTS: readonly number[] = (() => {
  const w = new Array<number>(TILE_COUNT).fill(1);
  for (const t of [0, 9, 90, 99]) w[t] = 6; // corners
  for (const t of [44, 45, 54, 55]) w[t] = 5; // centre
  for (const n of [7, 13, 21, 33, 77, 88, 100]) w[n - 1] = Math.max(w[n - 1], 4); // lucky numbers
  for (let i = 0; i < 10; i++) {
    w[i] = Math.max(w[i], 1.5);
    w[90 + i] = Math.max(w[90 + i], 1.5);
  }
  return w;
})();

/** Bots use the players' name generator (adjective + noun + 2 digits), seeded by bot index. */
export function botNickname(i: number): string {
  let x = (i + 1) * 0x9e3779b1;
  return generateDisplayName(() => {
    x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d);
    x ^= x >>> 12;
    return (x >>> 0) / 2 ** 32;
  });
}

export interface BotDeps {
  manager: RoomManager;
  clock: Clock;
  config: GameConfig;
  rng?: () => number;
  /** Per-tick move probability for an alive bot. */
  moveProb?: number;
}

const REACTION_MS = [40, 110, 200, 320];

export class BotDriver {
  private readonly bots: Bot[] = [];
  private readonly byRoom = new Map<string, Set<Bot>>();
  private readonly lastBettingRound = new Map<string, string>();
  private readonly rng: () => number;
  private readonly moveProb: number;

  constructor(private readonly deps: BotDeps) {
    this.rng = deps.rng ?? Math.random;
    this.moveProb = deps.moveProb ?? 0.02;
  }

  get count(): number {
    return this.bots.length;
  }

  setCount(n: number): void {
    const target = Math.max(0, Math.min(9_900, Math.floor(n)));
    while (this.bots.length > target) this.remove(this.bots.pop()!);
    while (this.bots.length < target) {
      const i = this.bots.length;
      const bot: Bot = { id: `bot:${i}`, nickname: botNickname(i), roomId: '', target: this.pickTarget() };
      this.bots.push(bot);
      this.seat(bot);
    }
  }

  /** Leave and re-join every bot (after the room soft cap changed). */
  reseat(): void {
    for (const b of this.bots) this.remove(b);
    for (const b of this.bots) this.seat(b);
  }

  private seat(b: Bot): void {
    const room = this.deps.manager.join(b.id, b.nickname);
    b.roomId = room.id;
    let set = this.byRoom.get(room.id);
    if (!set) this.byRoom.set(room.id, (set = new Set()));
    set.add(b);
    // Joining during betting: still bet this round.
    if (room.phase === 'betting') this.scheduleBets(room, [b]);
  }

  private remove(b: Bot): void {
    this.byRoom.get(b.roomId)?.delete(b);
    this.deps.manager.leave(b.id);
  }

  /** Called for every room broadcast; bots react like players watching the room. */
  onBroadcast(roomId: string, msg: BroadcastMessage): void {
    const bots = this.byRoom.get(roomId);
    const room = this.deps.manager.get(roomId);
    if (!bots || bots.size === 0 || !room) return;
    if (msg.t === 'roundState' && msg.phase === 'betting' && this.lastBettingRound.get(roomId) !== msg.roundId) {
      this.lastBettingRound.set(roomId, msg.roundId);
      for (const b of bots) b.target = this.pickTarget();
      this.scheduleBets(room, [...bots]);
    } else if (msg.t === 'tick') {
      this.react(room, bots, msg.stage, msg.removedCount, this.moveProb);
    } else if (msg.t === 'stageEnd') {
      this.react(room, bots, msg.stage, STAGE_REMOVALS[msg.stage - 1], this.moveProb * 5);
    }
  }

  private react(room: Room, bots: Set<Bot>, stage: Stage, k: number, moveProb: number): void {
    const batches: (() => void)[][] = REACTION_MS.map(() => []);
    const roundId = room.roundId;
    for (const b of bots) {
      const p = room.core.players.get(b.id);
      if (!p || p.state !== 'alive') continue;
      const reached = stage > b.target.stage || (stage === b.target.stage && k >= b.target.k);
      const slot = batches[Math.floor(this.rng() * batches.length)];
      if (reached && !(b.target.stage === 3 && b.target.k === 99)) slot.push(() => room.cashout(b.id));
      else if (this.rng() < moveProb) {
        const tile = this.pickTile(room);
        if (tile !== null) slot.push(() => room.move(b.id, tile));
      }
    }
    batches.forEach((actions, i) => {
      if (actions.length === 0) return;
      this.deps.clock.setTimeout(() => {
        if (room.closed || room.roundId !== roundId) return;
        for (const a of actions) a();
      }, REACTION_MS[i]);
    });
  }

  private scheduleBets(room: Room, bots: Bot[]): void {
    const roundId = room.roundId;
    const buckets = new Map<number, Bot[]>();
    const window = this.deps.config.bettingMs * 0.6;
    const left = room.phaseEndsAt === null ? window : Math.max(0, room.phaseEndsAt - this.deps.clock.now() - 300);
    for (const b of bots) {
      const delay = Math.round((this.rng() * Math.min(window, left)) / 100) * 100;
      let list = buckets.get(delay);
      if (!list) buckets.set(delay, (list = []));
      list.push(b);
    }
    for (const [delay, list] of buckets) {
      this.deps.clock.setTimeout(() => {
        if (room.closed || room.roundId !== roundId || room.phase !== 'betting') return;
        for (const b of list) void this.placeBet(room, b);
      }, delay);
    }
  }

  private async placeBet(room: Room, b: Bot): Promise<void> {
    if (b.roomId !== room.id) return;
    const { minBet, maxBet } = this.deps.config;
    // Mostly small stakes: 0.10 .. ~20.00, in 10-cent steps.
    const amount = Math.min(maxBet, Math.max(minBet, 10 * Math.floor(10 ** (this.rng() * 2.3))));
    for (let attempt = 0; attempt < 3; attempt++) {
      const tile = this.pickTile(room);
      if (tile === null) return;
      const r = await room.bet(b.id, amount, tile);
      if (r.ok || r.reason !== 'TILE_FULL') return;
    }
  }

  /** Weighted pick among tiles that are alive and not full in the bot's current (public) view. */
  private pickTile(room: Room): number | null {
    const { counts, gone } = room.core;
    const cap = this.deps.config.tileCapacity;
    let total = 0;
    for (let t = 0; t < TILE_COUNT; t++) if (!gone[t] && counts[t] < cap) total += TILE_WEIGHTS[t];
    if (total === 0) return null;
    let r = this.rng() * total;
    for (let t = 0; t < TILE_COUNT; t++) {
      if (gone[t] || counts[t] >= cap) continue;
      r -= TILE_WEIGHTS[t];
      if (r <= 0) return t;
    }
    return null;
  }

  private pickTarget(): { stage: Stage; k: number } {
    const u = this.rng();
    if (u < 0.8) return { stage: 1, k: 1 + Math.floor(90 * this.rng() ** 1.6) };
    if (u < 0.95) return { stage: 2, k: 1 + Math.floor(90 * this.rng()) };
    if (u < 0.99) return { stage: 3, k: 1 + Math.floor(98 * this.rng()) };
    return { stage: 3, k: 99 }; // rides for 10,000x
  }

  stats(): { bots: number; byRoom: Record<string, number> } {
    const byRoom: Record<string, number> = {};
    for (const [id, set] of this.byRoom) if (set.size) byRoom[id] = set.size;
    return { bots: this.bots.length, byRoom };
  }
}
