/** User-visible game title (spec §0.2). */
export const GAME_TITLE = 'Last Tile Standing';
/** Label for the three stages: "Stage 1 / Stage 2 / Stage 3". */
export const STAGE_LABEL = 'Stage';
export const stageName = (stage: number) => `${STAGE_LABEL} ${stage}`;

export const TILE_COUNT = 100;
export const GRID_SIZE = 10;
export const STAGE_COUNT = 3;
/** Tiles removed in each stage before resurrection (stage 1, 2) or the end (stage 3). */
export const STAGE_REMOVALS = [91, 90, 99] as const;

export type Stage = 1 | 2 | 3;

export interface GameConfig {
  tickMs: number;
  fastTickMs: number;
  bettingMs: number;
  intermissionMs: number;
  resultsMs: number;
  /** Move lock before each removal (BUILD_SPEC §3.4). 0 = disabled (CHANGES_3 §1). */
  moveLockMs: number;
  /** Absolute maximum players per tile. */
  tileCapacity: number;
  /**
   * Dynamic capacity (CHANGES_3 §2): a tile is Full at this percentage of the players in the room when the
   * round opens, never above tileCapacity. 0 disables it (fixed tileCapacity).
   */
  tileCapPct: number;
  roomSoftCap: number;
  /** Money values are integer minor units (cents). */
  minBet: number;
  maxBet: number;
  maxWinPerBet: number;
  currency: string;
  /** Interval for batched occupancy deltas between ticks. */
  occupancyMs: number;
  /** Interval for aggregated live feed. */
  liveFeedMs: number;
  /** Demo credits granted to a new nickname (minor units). */
  startingBalance: number;
  /** Close an extra room after this many consecutive empty rounds. */
  emptyRoundsBeforeClose: number;
  /** Move rate limit per socket (moves per second). */
  movesPerSecond: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  tickMs: 500,
  fastTickMs: 200,
  bettingMs: 10_000,
  intermissionMs: 3_000,
  resultsMs: 4_000,
  moveLockMs: 0,
  tileCapacity: 99,
  tileCapPct: 20,
  roomSoftCap: 2_000,
  minBet: 10,
  maxBet: 10_000,
  maxWinPerBet: 1_000_000,
  currency: 'EUR',
  occupancyMs: 100,
  liveFeedMs: 500,
  startingBalance: 100_000,
  emptyRoundsBeforeClose: 3,
  movesPerSecond: 5,
};

export interface TileCaps {
  /** Players counted for this round's thresholds. */
  playerBase: number;
  /** A tile with this many players is Full. */
  tileCap: number;
  /** Up to this many players a tile is green; above it yellow; at tileCap red/Full. */
  greenMax: number;
}

/** CHANGES_3 §2: tileCap = min(hardCap, max(1, ceil(pct% × base))), greenMax = floor(tileCap / 2). */
export function tileCapsFor(playerBase: number, pct: number, hardCap: number): TileCaps {
  const tileCap = pct > 0 ? Math.min(hardCap, Math.max(1, Math.ceil((playerBase * pct) / 100))) : hardCap;
  return { playerBase, tileCap, greenMax: Math.floor(tileCap / 2) };
}

export type TileBand = 'green' | 'yellow' | 'full' | 'gone';
export function tileBand(count: number, gone: boolean, caps: Pick<TileCaps, 'tileCap' | 'greenMax'>): TileBand {
  if (gone) return 'gone';
  if (count >= caps.tileCap) return 'full';
  return count <= caps.greenMax ? 'green' : 'yellow';
}
