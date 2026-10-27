import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Player identity (spec §0.1). Identity, currency and balance come from the aggregator's launch token,
 * never from the player. Without a token the game runs in demo mode with a generated identity.
 */

export interface LaunchParams {
  token?: string;
  operator?: string;
  currency?: string;
  lang?: string;
  mode?: 'real' | 'demo';
  lobbyUrl?: string;
}

export interface PlayerSession {
  playerId: string;
  displayName: string;
  currency: string;
  /** Opening balance in minor units, or null to keep the engine's own (demo) balance. */
  balance: number | null;
  mode: 'real' | 'demo';
  provider: 'aggregator' | 'demo';
  lang: string;
  lobbyUrl: string | null;
}

export interface SessionProvider {
  start(launch: LaunchParams): Promise<PlayerSession>;
}

/** Minimal key-value storage (localStorage in the page; a Map in tests). May throw. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_CURRENCY = 'EUR';
const CURRENCY_RE = /^[A-Z]{3}$/;

export function parseLaunchParams(search: string): LaunchParams {
  const q = new URLSearchParams(search);
  const get = (k: string) => q.get(k)?.trim() || undefined;
  const mode = get('mode');
  const currency = get('currency')?.toUpperCase();
  const lobbyUrl = get('lobbyUrl');
  return {
    token: get('token'),
    operator: get('operator'),
    currency: currency && CURRENCY_RE.test(currency) ? currency : undefined,
    lang: get('lang'),
    mode: mode === 'real' || mode === 'demo' ? mode : undefined,
    // Only http(s) lobby links; anything else (javascript:, data:) is dropped.
    lobbyUrl: lobbyUrl && /^https?:\/\//i.test(lobbyUrl) ? lobbyUrl : undefined,
  };
}

// ------------------------------------------------------------------ names

/** ~100 neutral adjectives and ~100 animal/nature nouns, CamelCase-friendly. */
export const NAME_ADJECTIVES: readonly string[] = (
  'Swift Brave Calm Clever Bright Bold Lucky Quiet Rapid Silent Sunny Witty Happy Jolly Keen Nimble Noble ' +
  'Proud Quick Royal Sharp Shiny Sly Smart Steady Sturdy Super Tidy Vivid Wild Wise Zesty Agile Amber Azure ' +
  'Blazing Breezy Cosmic Crimson Crystal Daring Dashing Dazzling Eager Electric Emerald Epic Fearless Fiery ' +
  'Fluffy Frosty Gentle Giant Golden Grand Hidden Icy Jade Jazzy Lively Loyal Lunar Magic Mellow Merry Mighty ' +
  'Misty Modest Neon Nifty Olive Polar Plucky Prime Radiant Rocky Rosy Rustic Sandy Scarlet Silver Snowy ' +
  'Solar Sparkly Speedy Spry Stellar Stormy Sunlit Tiny Topaz Turbo Velvet Violet Breezy Cheerful Crafty ' +
  'Dapper Fancy Glowing Humble Ivory'
)
  .split(' ')
  .filter((w, i, a) => a.indexOf(w) === i);

export const NAME_NOUNS: readonly string[] = (
  'Falcon Otter Panda Tiger Eagle Fox Wolf Bear Hawk Lynx Badger Beaver Bison Cobra Comet Condor Cougar Crane ' +
  'Dolphin Dragon Eel Elk Ferret Finch Gazelle Gecko Heron Hippo Ibis Jaguar Koala Lark Lemur Leopard Lion ' +
  'Llama Magpie Marmot Meerkat Mink Moose Narwhal Newt Ocelot Orca Osprey Owl Panther Parrot Pelican Penguin ' +
  'Puffin Puma Quail Rabbit Raven Robin Salmon Seal Shark Sparrow Squid Stag Stork Swan Tapir Toucan Turtle ' +
  'Walrus Whale Wombat Yak Zebra Acorn Aspen Birch Canyon Cedar Cliff Cloud Coral Delta Dune Ember Fern Fjord ' +
  'Glacier Grove Harbor Island Lagoon Maple Meadow Mesa Orchid Pebble Pine Prairie Reef River Summit Willow'
)
  .split(' ')
  .filter((w, i, a) => a.indexOf(w) === i);

export type Rng = () => number;

/** Uniform [0, 1) from the platform CSPRNG. */
export const cryptoRng: Rng = () => {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return b[0] / 2 ** 32;
};

/** Adjective + Noun + 2 digits, e.g. "SwiftFalcon27". */
export function generateDisplayName(rng: Rng = cryptoRng): string {
  const a = NAME_ADJECTIVES[Math.floor(rng() * NAME_ADJECTIVES.length)];
  const n = NAME_NOUNS[Math.floor(rng() * NAME_NOUNS.length)];
  const d = Math.floor(rng() * 100)
    .toString()
    .padStart(2, '0');
  return `${a}${n}${d}`;
}

export const DISPLAY_NAME_RE = /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/;

/** Stable pseudonym in the same format, derived from a hash of the player id. */
export function pseudonymFor(playerId: string): string {
  const h = sha256(utf8ToBytes(`lts-name:${playerId}`));
  let i = 0;
  return generateDisplayName(() => ((h[i++] << 8) | h[i++]) / 65_536);
}

/** Public lists show names as first 2 characters + "***" + last character ("Sw***7"). */
export function maskName(name: string): string {
  const s = [...name];
  if (s.length <= 3) return `${s[0] ?? ''}***`;
  return `${s[0]}${s[1]}***${s[s.length - 1]}`;
}

export function randomId(rng: Rng = cryptoRng, bytes = 12): string {
  let out = '';
  for (let i = 0; i < bytes; i++) out += Math.floor(rng() * 256).toString(16).padStart(2, '0');
  return out;
}

// ------------------------------------------------------------------ providers

const DEMO_KEY = 'lts.demo.identity';

/**
 * Demo mode (no token; this is the offline HTML). Generates a display name and a random playerId and
 * keeps them in storage. If storage is unavailable they are regenerated on every load.
 */
export class DemoSessionProvider implements SessionProvider {
  constructor(
    private readonly store: KeyValueStore | null,
    private readonly rng: Rng = cryptoRng,
  ) {}

  async start(launch: LaunchParams): Promise<PlayerSession> {
    const id = this.load() ?? this.newIdentity();
    return {
      playerId: id.playerId,
      displayName: id.displayName,
      currency: launch.currency ?? DEFAULT_CURRENCY,
      balance: null,
      mode: 'demo',
      provider: 'demo',
      lang: launch.lang ?? 'en',
      lobbyUrl: launch.lobbyUrl ?? null,
    };
  }

  /** Generate and persist a fresh identity ("New demo identity" in Settings). */
  newIdentity(): { playerId: string; displayName: string } {
    const id = { playerId: `demo:${randomId(this.rng)}`, displayName: generateDisplayName(this.rng) };
    try {
      this.store?.setItem(DEMO_KEY, JSON.stringify(id));
    } catch {
      /* storage blocked: identity lasts for this page load only */
    }
    return id;
  }

  private load(): { playerId: string; displayName: string } | null {
    try {
      const raw = this.store?.getItem(DEMO_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as { playerId?: unknown; displayName?: unknown };
      if (typeof v.playerId === 'string' && typeof v.displayName === 'string' && v.playerId && v.displayName) {
        return { playerId: v.playerId, displayName: v.displayName };
      }
    } catch {
      /* unreadable: start over */
    }
    return null;
  }
}

/** What the operator's backend returns for a launch token. */
export interface AggregatorPlayer {
  playerId: string;
  displayName?: string;
  currency?: string;
  balance?: number;
  mode?: 'real' | 'demo';
}

/**
 * Aggregator launch (`?token=…`). STUB: real deployments must validate the token server-to-server
 * with the aggregator (e.g. POST /session/validate {token, operator}) from the game server, never from
 * the browser, and take playerId, currency, balance and mode from that response. Plug that call in as
 * `validate`. The default stub trusts nothing from the player: it derives the id from a hash of the token,
 * so the same token always maps to the same pseudonymous player.
 */
export class AggregatorSessionProvider implements SessionProvider {
  constructor(private readonly validate: (launch: LaunchParams) => Promise<AggregatorPlayer> = stubValidate) {}

  async start(launch: LaunchParams): Promise<PlayerSession> {
    if (!launch.token) throw new Error('aggregator launch without a token');
    const p = await this.validate(launch);
    const currency = (p.currency ?? launch.currency ?? DEFAULT_CURRENCY).toUpperCase();
    return {
      playerId: p.playerId,
      displayName: p.displayName?.trim() || pseudonymFor(p.playerId),
      currency: CURRENCY_RE.test(currency) ? currency : DEFAULT_CURRENCY,
      balance: Number.isInteger(p.balance) && p.balance! >= 0 ? p.balance! : null,
      mode: p.mode ?? launch.mode ?? 'demo',
      provider: 'aggregator',
      lang: launch.lang ?? 'en',
      lobbyUrl: launch.lobbyUrl ?? null,
    };
  }
}

async function stubValidate(launch: LaunchParams): Promise<AggregatorPlayer> {
  const id = bytesToHex(sha256(utf8ToBytes(`${launch.operator ?? ''}:${launch.token}`))).slice(0, 24);
  return { playerId: `agg:${id}`, currency: launch.currency };
}

/** Token present → aggregator; otherwise demo. */
export function chooseSessionProvider(launch: LaunchParams, store: KeyValueStore | null): SessionProvider {
  return launch.token ? new AggregatorSessionProvider() : new DemoSessionProvider(store);
}
