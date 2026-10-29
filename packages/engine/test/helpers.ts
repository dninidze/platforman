import {
  DEFAULT_CONFIG,
  FakeClock,
  deriveSequences,
  type BroadcastMessage,
  type GameConfig,
  type ServerMessage,
} from '@p3/shared';
import { MemoryAuditLog } from '../src/audit';
import { Room } from '../src/room';
import { MockWallet } from '../src/wallet';

export const SEED = 'c0ffee'.padEnd(64, '0');

export function setupRoom(over: Partial<GameConfig> = {}) {
  const clock = new FakeClock(0);
  // Legacy tests assume the fixed 99-per-tile cap; dynamic-capacity tests pass tileCapPct explicitly.
  const config: GameConfig = { ...DEFAULT_CONFIG, tileCapPct: 0, tileCapacity: 99, ...over };
  const wallet = new MockWallet(config.startingBalance);
  const audit = new MemoryAuditLog();
  const broadcasts: BroadcastMessage[] = [];
  const direct: { playerId: string; msg: ServerMessage }[] = [];
  const room = new Room('EUR-1', 'EUR', {
    config,
    clock,
    wallet,
    audit,
    seedSource: () => SEED,
    sink: {
      broadcast: (_id, msg) => broadcasts.push(msg),
      sendToPlayer: (playerId, msg) => direct.push({ playerId, msg }),
    },
  });
  room.start();
  const seqs = () => deriveSequences(SEED, `EUR-1#${room.roundNo}:${room.roundNo}`);
  const join = (...ids: string[]) => ids.forEach((id) => room.addMember({ playerId: id, nickname: id }));
  /** A tile that survives the whole of `stage` in the current round. */
  const safeTile = (stage: number, skip = 0) => [...Array(100).keys()].filter((t) => !seqs()[stage - 1].includes(t))[skip];
  const of = <T extends BroadcastMessage['t']>(t: T) =>
    broadcasts.filter((m): m is Extract<BroadcastMessage, { t: T }> => m.t === t);
  return { clock, config, wallet, audit, room, broadcasts, direct, seqs, join, safeTile, of };
}

/** Let pending promise callbacks (wallet calls) run. */
export const flush = () => new Promise<void>((r) => setImmediate(r));
