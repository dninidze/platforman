import { DEFAULT_CONFIG, type GameConfig, type PublicConfig } from '@p3/shared';

/** Defaults from §12 with optional overrides (the in-page host passes its settings here). */
export function makeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

export function publicConfig(c: GameConfig): PublicConfig {
  const { tickMs, fastTickMs, bettingMs, intermissionMs, resultsMs, moveLockMs, tileCapacity, tileCapPct, minBet, maxBet, maxWinPerBet, currency } = c;
  return { tickMs, fastTickMs, bettingMs, intermissionMs, resultsMs, moveLockMs, tileCapacity, tileCapPct, minBet, maxBet, maxWinPerBet, currency };
}
