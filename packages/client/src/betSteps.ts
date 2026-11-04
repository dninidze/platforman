/** Up to 3 integer digits and 2 decimals (CHANGES_7 §7). */
export const AMOUNT_RE = /^\d{0,3}(\.\d{0,2})?$/;
/** Amount box text: 2 decimals, whole numbers from 100. */
export const formatAmount = (minor: number) => (minor >= 10_000 ? String(minor / 100) : (minor / 100).toFixed(2));

/**
 * − / + grid (CHANGES_7 §7): 0.10 steps up to 1, 1 up to 10, 5 up to 100. Moves to the next grid value
 * above (dir 1) or below (dir -1) the current amount.
 */
export function stepBet(minor: number, dir: 1 | -1, min: number, max: number): number {
  const grid: number[] = [];
  for (let v = 10; v <= 100; v += 10) grid.push(v);
  for (let v = 200; v <= 1_000; v += 100) grid.push(v);
  for (let v = 1_500; v <= 10_000; v += 500) grid.push(v);
  const g = grid.filter((v) => v >= min && v <= max);
  if (dir > 0) return g.find((v) => v > minor) ?? g[g.length - 1];
  return [...g].reverse().find((v) => v < minor) ?? g[0];
}

