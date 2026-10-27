import { describe, expect, it } from 'vitest';
import {
  AggregatorSessionProvider,
  DISPLAY_NAME_RE,
  DemoSessionProvider,
  NAME_ADJECTIVES,
  NAME_NOUNS,
  chooseSessionProvider,
  generateDisplayName,
  maskName,
  parseLaunchParams,
  pseudonymFor,
  type KeyValueStore,
} from '../src';

const memStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const blockedStore: KeyValueStore = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
};

describe('display names', () => {
  it('uses ~100 distinct adjectives and nouns', () => {
    expect(NAME_ADJECTIVES.length).toBeGreaterThanOrEqual(95);
    expect(NAME_NOUNS.length).toBeGreaterThanOrEqual(95);
    expect(new Set(NAME_ADJECTIVES).size).toBe(NAME_ADJECTIVES.length);
    for (const w of [...NAME_ADJECTIVES, ...NAME_NOUNS]) expect(w).toMatch(/^[A-Z][a-z]+$/);
  });

  it('generates adjective + noun + 2 digits', () => {
    for (let i = 0; i < 500; i++) expect(generateDisplayName()).toMatch(DISPLAY_NAME_RE);
    expect(generateDisplayName(() => 0)).toBe(`${NAME_ADJECTIVES[0]}${NAME_NOUNS[0]}00`);
  });

  it('derives a stable pseudonym from a player id', () => {
    expect(pseudonymFor('agg:123')).toBe(pseudonymFor('agg:123'));
    expect(pseudonymFor('agg:123')).toMatch(DISPLAY_NAME_RE);
    expect(pseudonymFor('agg:124')).not.toBe(pseudonymFor('agg:123'));
  });

  it('masks names as first 2 + *** + last character', () => {
    expect(maskName('SwiftFalcon27')).toBe('Sw***7');
    expect(maskName('rider')).toBe('ri***r');
    expect(maskName('abcd')).toBe('ab***d');
    expect(maskName('abc')).toBe('a***');
    expect(maskName('')).toBe('***');
  });
});

describe('launch params', () => {
  it('parses token, operator, currency, lang, mode, lobbyUrl', () => {
    expect(parseLaunchParams('?token=abc&operator=op1&currency=usd&lang=de&mode=real&lobbyUrl=https://op.example/lobby')).toEqual({
      token: 'abc',
      operator: 'op1',
      currency: 'USD',
      lang: 'de',
      mode: 'real',
      lobbyUrl: 'https://op.example/lobby',
    });
  });
  it('drops invalid currency, mode and non-http lobby links', () => {
    const p = parseLaunchParams('?currency=dollars&mode=god&lobbyUrl=javascript:alert(1)');
    expect(p.currency).toBeUndefined();
    expect(p.mode).toBeUndefined();
    expect(p.lobbyUrl).toBeUndefined();
    expect(parseLaunchParams('').token).toBeUndefined();
  });
});

describe('DemoSessionProvider', () => {
  it('generates and persists an identity, so a reload keeps the same name', async () => {
    const store = memStore();
    const a = await new DemoSessionProvider(store).start({});
    expect(a).toMatchObject({ provider: 'demo', mode: 'demo', currency: 'EUR', balance: null });
    expect(a.displayName).toMatch(DISPLAY_NAME_RE);
    expect(a.playerId).toMatch(/^demo:[0-9a-f]{24}$/);
    const b = await new DemoSessionProvider(store).start({ currency: 'GBP' });
    expect(b.playerId).toBe(a.playerId);
    expect(b.displayName).toBe(a.displayName);
    expect(b.currency).toBe('GBP');
  });

  it('"New demo identity" regenerates name and id', async () => {
    const store = memStore();
    const p = new DemoSessionProvider(store);
    const a = await p.start({});
    p.newIdentity();
    const b = await new DemoSessionProvider(store).start({});
    expect(b.playerId).not.toBe(a.playerId);
  });

  it('works without storage (regenerated each load) and ignores corrupt data', async () => {
    const a = await new DemoSessionProvider(blockedStore).start({});
    const b = await new DemoSessionProvider(blockedStore).start({});
    expect(a.displayName).toMatch(DISPLAY_NAME_RE);
    expect(b.playerId).not.toBe(a.playerId);
    const store = memStore();
    store.setItem('lts.demo.identity', '{not json');
    expect((await new DemoSessionProvider(store).start({})).displayName).toMatch(DISPLAY_NAME_RE);
  });
});

describe('AggregatorSessionProvider', () => {
  it('is chosen when a token is present; the stub maps a token to a stable pseudonymous player', async () => {
    const launch = parseLaunchParams('?token=abc&currency=USD');
    const provider = chooseSessionProvider(launch, memStore());
    expect(provider).toBeInstanceOf(AggregatorSessionProvider);
    const s1 = await provider.start(launch);
    const s2 = await new AggregatorSessionProvider().start(launch);
    expect(s1).toMatchObject({ provider: 'aggregator', currency: 'USD', balance: null });
    expect(s1.playerId).toMatch(/^agg:[0-9a-f]{24}$/);
    expect(s2.playerId).toBe(s1.playerId);
    expect(s1.displayName).toBe(pseudonymFor(s1.playerId));
    expect(chooseSessionProvider(parseLaunchParams(''), null)).toBeInstanceOf(DemoSessionProvider);
  });

  it('uses the aggregator-supplied name, currency and balance from the validation call', async () => {
    const p = new AggregatorSessionProvider(async () => ({ playerId: 'op1-42', displayName: 'Lucky Lena', currency: 'gbp', balance: 2_500, mode: 'real' }));
    expect(await p.start({ token: 't' })).toMatchObject({ playerId: 'op1-42', displayName: 'Lucky Lena', currency: 'GBP', balance: 2_500, mode: 'real' });
    await expect(new AggregatorSessionProvider().start({})).rejects.toThrow(/token/);
  });
});
