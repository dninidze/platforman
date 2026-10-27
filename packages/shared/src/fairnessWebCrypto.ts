import { STAGE_REMOVALS, TILE_COUNT, type Stage } from './constants';
import type { FairnessRecord, VerifyResult } from './fairness';

/**
 * Independent re-implementation of the provably-fair derivation on Web Crypto (`crypto.subtle`), used
 * by the in-page verifier. It follows the same conventions as fairness.ts (which the engine uses):
 * SHA-256 over the hex seed string, HMAC key = utf8(serverSeed), message `${clientSeed}:${stage}:${counter}`,
 * big-endian uint32 chunks, rejection sampling, forward Fisher–Yates. A unit test asserts both agree.
 */

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Web Crypto (crypto.subtle) is not available in this context');
  return s;
}

export async function hashServerSeedWebCrypto(serverSeed: string): Promise<string> {
  return hex(await subtle().digest('SHA-256', enc.encode(serverSeed)));
}

export async function derivePermutationWebCrypto(serverSeed: string, clientSeed: string, stage: Stage): Promise<number[]> {
  const key = await subtle().importKey('raw', enc.encode(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let counter = 0;
  let block = new DataView(new ArrayBuffer(0));
  let pos = 8;
  const nextUint32 = async () => {
    if (pos >= 8) {
      block = new DataView(await subtle().sign('HMAC', key, enc.encode(`${clientSeed}:${stage}:${counter++}`)));
      pos = 0;
    }
    return block.getUint32(pos++ * 4, false);
  };
  const perm = Array.from({ length: TILE_COUNT }, (_, i) => i);
  for (let i = 0; i < TILE_COUNT - 1; i++) {
    const n = TILE_COUNT - i;
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    let u = await nextUint32();
    while (u >= limit) u = await nextUint32();
    const j = i + (u % n);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

export async function deriveSequencesWebCrypto(serverSeed: string, clientSeed: string): Promise<number[][]> {
  const perms = await Promise.all([1, 2, 3].map((s) => derivePermutationWebCrypto(serverSeed, clientSeed, s as Stage)));
  return perms.map((p, i) => p.slice(0, STAGE_REMOVALS[i]));
}

/** Same checks as verifyRound(), computed with Web Crypto. */
export async function verifyRoundWebCrypto(rec: FairnessRecord): Promise<VerifyResult> {
  const errors: string[] = [];
  const hashOk = (await hashServerSeedWebCrypto(rec.serverSeed)) === rec.serverSeedHash;
  if (!hashOk) errors.push('SHA256(serverSeed) does not match the published hash');
  const derived = await deriveSequencesWebCrypto(rec.serverSeed, rec.clientSeed);
  const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const sequencesOk = derived.map((seq, i) => {
    const ok = same(seq, rec.sequences[i] ?? []);
    if (!ok) errors.push(`stage ${i + 1} sequence differs from the revealed one`);
    return ok;
  });
  const playedOk = derived.map((seq, i) => {
    const played = rec.played?.[i] ?? [];
    const ok = played.length <= seq.length && same(seq.slice(0, played.length), played);
    if (!ok) errors.push(`stage ${i + 1} played tiles are not a prefix of the derived sequence`);
    return ok;
  });
  return { ok: errors.length === 0, hashOk, sequencesOk, playedOk, derived, errors };
}
