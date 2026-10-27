import type { RoomInfo } from '@p3/shared';
import { Room, type RoomDeps } from './room';

export type ManagerDeps = Omit<RoomDeps, 'onRoundEnd'> & {
  onRoomOpened?: (room: Room) => void;
  onRoomClosed?: (room: Room) => void;
};

/**
 * Holds N rooms per currency. Joiners go to the fullest open room below roomSoftCap; a new room
 * opens when none qualifies. Extra rooms close after `emptyRoundsBeforeClose` empty rounds.
 */
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly homeOf = new Map<string, string>();
  private counter = new Map<string, number>();

  constructor(private readonly deps: ManagerDeps) {
    this.open(deps.config.currency);
  }

  open(currency: string): Room {
    const n = (this.counter.get(currency) ?? 0) + 1;
    this.counter.set(currency, n);
    const room = new Room(`${currency}-${n}`, currency, { ...this.deps, onRoundEnd: (r) => this.onRoundEnd(r) });
    this.rooms.set(room.id, room);
    room.start();
    this.deps.audit.event('room_opened', { roomId: room.id });
    this.deps.onRoomOpened?.(room);
    return room;
  }

  /** Assign a player to a room (or return the room they are already in). */
  join(playerId: string, nickname: string, currency = this.deps.config.currency): Room {
    const existing = this.roomOf(playerId);
    if (existing) {
      existing.addMember({ playerId, nickname });
      return existing;
    }
    const cap = this.deps.config.roomSoftCap;
    let best: Room | null = null;
    for (const r of this.rooms.values()) {
      if (r.currency !== currency || r.closed || r.members.size >= cap) continue;
      if (!best || r.members.size > best.members.size) best = r;
    }
    const room = best ?? this.open(currency);
    room.addMember({ playerId, nickname });
    this.homeOf.set(playerId, room.id);
    return room;
  }

  leave(playerId: string): void {
    const room = this.roomOf(playerId);
    room?.removeMember(playerId);
    // A live bet keeps the player's home room, so reconnecting lands them back on their tile.
    const p = room?.core.players.get(playerId);
    if (!p || (p.state !== 'alive' && p.state !== 'betting')) this.homeOf.delete(playerId);
  }

  roomOf(playerId: string): Room | undefined {
    const id = this.homeOf.get(playerId);
    return id ? this.rooms.get(id) : undefined;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  list(): RoomInfo[] {
    return [...this.rooms.values()].map((r) => ({ roomId: r.id, currency: r.currency, players: r.members.size }));
  }

  private onRoundEnd(room: Room): void {
    const sameCurrency = [...this.rooms.values()].filter((r) => r.currency === room.currency && !r.closed);
    if (room.emptyRounds >= this.deps.config.emptyRoundsBeforeClose && sameCurrency.length > 1) {
      room.close();
      this.rooms.delete(room.id);
      this.deps.audit.event('room_closed', { roomId: room.id, emptyRounds: room.emptyRounds });
      this.deps.onRoomClosed?.(room);
    }
  }

  shutdown(): void {
    for (const r of this.rooms.values()) r.close();
  }
}
