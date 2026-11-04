import type { RoundHighlights } from '@p3/shared';

/**
 * "Top" results for 24h / Week / Month / Year (CHANGES_6 §10), kept on this device.
 *
 * Rounds are stored in hour buckets for the last 7 days and in day buckets for the last 366 days. Each
 * bucket keeps only its top N by every sort key, so a rolling top N over whole buckets is exact; the edge
 * bucket makes the windows accurate to the hour (24h, Week) or the day (Month, Year).
 */

export type TopWindow = '24h' | 'week' | 'month' | 'year';
export type TopSort = 'man' | 'cashX' | 'cashWin';

export interface TopEntry {
  /** Round id as shown (round ids restart when the page reloads, so `t` disambiguates). */
  id: string;
  /** Round end time (ms since epoch). */
  t: number;
  /** Stage the round reached: where the board emptied, or 3 if a player survived to the end. */
  reached: number;
  highlights: RoundHighlights;
}

const KEY = 'pf.top.v1';
const HOUR = 3_600_000;
const DAY = 86_400_000;
export const TOP_N = 10;
const SPAN: Record<TopWindow, number> = { '24h': DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };

interface Stored {
  h: Record<string, TopEntry[]>;
  d: Record<string, TopEntry[]>;
}

const keyValue: Record<TopSort, (e: TopEntry) => number> = {
  man: (e) => e.highlights.topMan?.multiplier ?? -1,
  cashX: (e) => e.highlights.topCashout?.multiplier ?? -1,
  cashWin: (e) => e.highlights.topCashout?.amount ?? -1,
};

/** Keep the union of the bucket's top N by every sort key. */
function prune(entries: TopEntry[]): TopEntry[] {
  const keep = new Set<TopEntry>();
  for (const k of Object.keys(keyValue) as TopSort[]) {
    [...entries].sort((a, b) => keyValue[k](b) - keyValue[k](a)).slice(0, TOP_N).forEach((e) => keep.add(e));
  }
  return entries.filter((e) => keep.has(e));
}

export class TopResults {
  private data: Stored;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.data = { h: {}, d: {} };
    try {
      const raw = storage?.getItem(KEY);
      if (raw) {
        const v = JSON.parse(raw) as Stored;
        if (v && typeof v.h === 'object' && typeof v.d === 'object') this.data = v;
      }
    } catch {
      /* unreadable or blocked storage: start empty */
    }
  }

  add(e: TopEntry, now = e.t): void {
    const hk = String(Math.floor(e.t / HOUR));
    const dk = String(Math.floor(e.t / DAY));
    if (this.data.h[hk]?.some((x) => x.id === e.id && x.t === e.t)) return;
    this.data.h[hk] = prune([...(this.data.h[hk] ?? []), e]);
    this.data.d[dk] = prune([...(this.data.d[dk] ?? []), e]);
    // Drop buckets nobody can query any more.
    for (const k of Object.keys(this.data.h)) if (Number(k) * HOUR < now - SPAN.week - HOUR) delete this.data.h[k];
    for (const k of Object.keys(this.data.d)) if (Number(k) * DAY < now - SPAN.year - DAY) delete this.data.d[k];
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage full or blocked: keep in memory */
    }
  }

  query(window: TopWindow, sort: TopSort, now = Date.now()): TopEntry[] {
    const from = now - SPAN[window];
    const buckets = window === '24h' || window === 'week' ? this.data.h : this.data.d;
    const all: TopEntry[] = [];
    for (const list of Object.values(buckets)) for (const e of list) if (e.t >= from && e.t <= now) all.push(e);
    return all
      .filter((e) => keyValue[sort](e) >= 0)
      .sort((a, b) => keyValue[sort](b) - keyValue[sort](a) || b.t - a.t)
      .slice(0, TOP_N);
  }
}
