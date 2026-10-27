import { DEFAULT_CONFIG, type GameConfig, type PublicConfig } from '@p3/shared';

export interface ServerConfig extends GameConfig {
  port: number;
  dataDir: string;
}

/** Keys whose env values are money in major units (e.g. MIN_BET=0.10). */
const MONEY_KEYS = new Set<keyof GameConfig>(['minBet', 'maxBet', 'maxWinPerBet', 'startingBalance']);

const toEnv = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();

/** Defaults from §12, each overridable by env (tickMs -> TICK_MS, minBet -> MIN_BET in major units). */
export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const cfg: ServerConfig = { ...DEFAULT_CONFIG, port: 8080, dataDir: 'data' };
  for (const key of Object.keys(cfg) as (keyof ServerConfig)[]) {
    const raw = env[toEnv(key)];
    if (raw === undefined || raw === '') continue;
    if (typeof cfg[key] === 'string') {
      (cfg as unknown as Record<string, unknown>)[key] = raw;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${toEnv(key)} must be a number`);
      (cfg as unknown as Record<string, unknown>)[key] = MONEY_KEYS.has(key as keyof GameConfig) ? Math.round(n * 100) : n;
    }
  }
  return { ...cfg, ...overrides };
}

export function publicConfig(c: GameConfig): PublicConfig {
  const { tickMs, fastTickMs, bettingMs, intermissionMs, resultsMs, moveLockMs, tileCapacity, minBet, maxBet, maxWinPerBet, currency } = c;
  return { tickMs, fastTickMs, bettingMs, intermissionMs, resultsMs, moveLockMs, tileCapacity, minBet, maxBet, maxWinPerBet, currency };
}
