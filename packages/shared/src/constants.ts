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
  moveLockMs: number;
  tileCapacity: number;
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
  moveLockMs: 100,
  tileCapacity: 99,
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
