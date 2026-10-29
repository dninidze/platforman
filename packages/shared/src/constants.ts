/** User-visible game title (spec §0.2). */
export const GAME_TITLE = 'Last Tile Standing';
/** Label for the three stages: "Vol. 1 / Vol. 2 / Vol. 3" (CHANGES_4 §1). */
export const STAGE_LABEL = 'Vol.';
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
  /** Fixed maximum players per tile; 0 = no fixed maximum (CHANGES_4 §3 removed the old 99). */
  tileCapacity: number;
  /**
   * CHANGES_4 §3: when the round starts, a tile with this percentage of the bets (or more) is locked.
   * 0 disables the dynamic lock (then only tileCapacity applies).
   */
  tileCapPct: number;
  /** Tiles turn yellow from this percentage of the bets. */
  tileYellowPct: number;
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
  tileCapacity: 0,
  tileCapPct: 10,
  tileYellowPct: 5,
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
  /** Players with a bet: live during betting, frozen when the round starts. */
  playerBase: number;
  /** A tile with this many players is locked (red). */
  tileCap: number;
  /** From this many players a tile is yellow. */
  yellowFrom: number;
  /** True during betting: display only, nothing is locked yet. */
  live: boolean;
}

/** Hard per-tile maximum from config (0 = none). */
export const hardTileCap = (tileCapacity: number) => (tileCapacity > 0 ? tileCapacity : Number.POSITIVE_INFINITY);

/** CHANGES_4 §3: lock at max(1, ceil(capPct% × bets)), yellow from max(1, ceil(yellowPct% × bets)). */
export function tileCapsFor(bets: number, capPct: number, yellowPct: number, live: boolean): TileCaps {
  const tileCap = Math.max(1, Math.ceil((bets * capPct) / 100));
  const yellowFrom = Math.min(tileCap, Math.max(1, Math.ceil((bets * yellowPct) / 100)));
  return { playerBase: bets, tileCap, yellowFrom, live };
}

export type TileBand = 'green' | 'yellow' | 'full' | 'gone';
export function tileBand(count: number, gone: boolean, caps: Pick<TileCaps, 'tileCap' | 'yellowFrom'>): TileBand {
  if (gone) return 'gone';
  if (count >= caps.tileCap) return 'full';
  return count >= caps.yellowFrom ? 'yellow' : 'green';
}

/** Multiplier label: two decimals below 100x, whole numbers from 100x ("105x", "10,000x"). */
export function formatMultiplier(m: number): string {
  return m >= 100 ? `${Math.floor(m).toLocaleString('en-US')}x` : `${m.toFixed(2)}x`;
}
