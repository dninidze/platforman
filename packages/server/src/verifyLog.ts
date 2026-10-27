/**
 * Re-verify every logged round: seed hash, all three sequences, played tiles, tick order and payouts.
 * Usage: npm run verify [-- path/to/rounds.jsonl]
 */
import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, getMultiplier100, payout, verifyRound, type Stage } from '@p3/shared';
import type { RoundRecord } from './audit';

export function checkRecord(rec: RoundRecord, maxWin = DEFAULT_CONFIG.maxWinPerBet): string[] {
  const errors = [...verifyRound(rec).errors];
  const tickTiles = [1, 2, 3].map((s) => rec.ticks.filter((t) => t[0] === s).map((t) => t[2]));
  tickTiles.forEach((tiles, i) => {
    if (tiles.join() !== rec.played[i].join()) errors.push(`stage ${i + 1}: tick log differs from played tiles`);
  });
  for (const p of rec.players) {
    if (p.outcome === 'lost' && p.payout !== 0) errors.push(`${p.playerId}: lost but paid`);
    if (p.outcome === 'cashout' || p.outcome === 'maxWin' || p.outcome === 'survived') {
      const expected = payout(p.bet, getMultiplier100(p.stage as Stage, p.k!), maxWin);
      if (expected !== p.payout) errors.push(`${p.playerId}: paid ${p.payout}, expected ${expected}`);
    }
  }
  return errors;
}

async function main() {
  const file = resolve(process.argv[2] ?? fileURLToPath(new URL('../../../data/rounds.jsonl', import.meta.url)));
  if (!existsSync(file)) {
    console.error(`no round log at ${file}`);
    process.exit(2);
  }
  let rounds = 0;
  let bad = 0;
  for await (const line of createInterface({ input: createReadStream(file) })) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line) as RoundRecord;
    rounds++;
    const errors = checkRecord(rec);
    if (errors.length) {
      bad++;
      console.log(`FAIL ${rec.roundId}: ${errors.join('; ')}`);
    }
  }
  console.log(`${rounds} rounds checked, ${rounds - bad} verified, ${bad} failed (${file})`);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();
