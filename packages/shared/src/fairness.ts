import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { STAGE_REMOVALS, TILE_COUNT, type Stage } from './constants';

/**
 * Provably-fair derivation, shared verbatim by the server and the client verifier.
 *
 * Conventions (documented in the README):
 * - serverSeed is 32 random bytes written as 64 lowercase hex chars.
 * - serverSeedHash = hex(SHA256(utf8(serverSeed))): the hex string is hashed, so anyone can check it
 *   with a standard SHA-256 tool.
 * - The HMAC key is utf8(serverSeed); message = `${clientSeed}:${stage}:${counter}`, counter from 0.
 * - Each HMAC output gives eight big-endian uint32 chunks. A draw in [0, n) rejects values
 *   >= floor(2^32 / n) * n to avoid modulo bias.
 * - Forward Fisher-Yates: for i = 0..98 swap(i, i + draw(100 - i)). Stage s uses the first
 *   STAGE_REMOVALS[s-1] entries; in stage 3 the last entry (index 99) is the 10,000x tile.
 */

export function generateServerSeed(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function hashServerSeed(serverSeed: string): string {
  return bytesToHex(sha256(utf8ToBytes(serverSeed)));
}

/** Pluggable client seed. The MVP uses round id + public nonce; no player input. */
export interface ClientSeedProvider {
  clientSeedFor(roundId: string, nonce: number): string;
}

export const defaultClientSeedProvider: ClientSeedProvider = {
  clientSeedFor: (roundId, nonce) => `${roundId}:${nonce}`,
};

class HmacStream {
  private readonly base;
  private counter = 0;
  private block: Uint8Array = new Uint8Array(0);
  private pos = 8;

  constructor(
    serverSeed: string,
    private readonly prefix: string,
  ) {
    this.base = hmac.create(sha256, utf8ToBytes(serverSeed));
  }

  nextUint32(): number {
    if (this.pos >= 8) {
      this.block = this.base.clone().update(utf8ToBytes(`${this.prefix}:${this.counter++}`)).digest();
      this.pos = 0;
    }
    const o = this.pos++ * 4;
    const b = this.block;
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  /** Uniform integer in [0, n) via rejection sampling. */
  nextInt(n: number): number {
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    for (;;) {
      const u = this.nextUint32();
      if (u < limit) return u % n;
    }
  }
}

export function derivePermutation(serverSeed: string, clientSeed: string, stage: Stage): number[] {
  const stream = new HmacStream(serverSeed, `${clientSeed}:${stage}`);
  const perm = Array.from({ length: TILE_COUNT }, (_, i) => i);
  for (let i = 0; i < TILE_COUNT - 1; i++) {
    const j = i + stream.nextInt(TILE_COUNT - i);
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  return perm;
}

/** Full permutations for the 3 stages. */
export function derivePermutations(serverSeed: string, clientSeed: string): number[][] {
  return [1, 2, 3].map((s) => derivePermutation(serverSeed, clientSeed, s as Stage));
}

/** Removal sequences actually used: 91, 90 and 99 tiles. */
export function deriveSequences(serverSeed: string, clientSeed: string): number[][] {
  return derivePermutations(serverSeed, clientSeed).map((p, i) => p.slice(0, STAGE_REMOVALS[i]));
}

/** The tile left standing at the end of stage 3 (the 10,000x tile). */
export function jackpotTile(permutationStage3: readonly number[]): number {
  return permutationStage3[TILE_COUNT - 1];
}

export function isPermutation(arr: readonly number[], n = TILE_COUNT): boolean {
  if (arr.length !== n) return false;
  const seen = new Uint8Array(n);
  for (const v of arr) {
    if (!Number.isInteger(v) || v < 0 || v >= n || seen[v]) return false;
    seen[v] = 1;
  }
  return true;
}

export interface FairnessRecord {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  /** Revealed sequences (91/90/99 entries). */
  sequences: number[][];
  /** Tiles actually removed, per stage, in order (a prefix of the sequence if the round ended early). */
  played?: number[][];
}

export interface VerifyResult {
  ok: boolean;
  hashOk: boolean;
  sequencesOk: boolean[];
  playedOk: boolean[];
  derived: number[][];
  errors: string[];
}

export function verifyRound(rec: FairnessRecord): VerifyResult {
  const errors: string[] = [];
  const hashOk = hashServerSeed(rec.serverSeed) === rec.serverSeedHash;
  if (!hashOk) errors.push('SHA256(serverSeed) does not match the published hash');
  const derived = deriveSequences(rec.serverSeed, rec.clientSeed);
  const sequencesOk = derived.map((seq, i) => {
    const ok = sameArray(seq, rec.sequences[i] ?? []);
    if (!ok) errors.push(`stage ${i + 1} sequence differs from the revealed one`);
    return ok;
  });
  const playedOk = derived.map((seq, i) => {
    const played = rec.played?.[i] ?? [];
    const ok = played.length <= seq.length && sameArray(seq.slice(0, played.length), played);
    if (!ok) errors.push(`stage ${i + 1} played tiles are not a prefix of the derived sequence`);
    return ok;
  });
  return { ok: errors.length === 0, hashOk, sequencesOk, playedOk, derived, errors };
}

function sameArray(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
