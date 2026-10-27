import { DEFAULT_CONFIG, type ServerMessage, type TickMsg } from '@p3/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { MemoryAuditLog } from '../src/audit';
import { startServer, type RunningServer } from '../src/gateway';
import { checkRecord } from '../src/verifyLog';

const FAST = {
  ...DEFAULT_CONFIG,
  port: 0,
  dataDir: '',
  bettingMs: 400,
  tickMs: 40,
  fastTickMs: 10,
  intermissionMs: 100,
  resultsMs: 200,
  moveLockMs: 10,
  occupancyMs: 20,
};

class Client {
  readonly ws: WebSocket;
  readonly msgs: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; res: (m: ServerMessage) => void }[] = [];
  private rid = 0;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
    });
  }
  open() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }
  send(msg: object) {
    const rid = ++this.rid;
    this.ws.send(JSON.stringify({ ...msg, rid }));
    return rid;
  }
  wait<T extends ServerMessage>(pred: (m: ServerMessage) => boolean, timeout = 10_000): Promise<T> {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), timeout);
      this.waiters.push({ pred, res: (m) => (clearTimeout(t), res(m as T)) });
    });
  }
  ticks(roundId: string) {
    return this.msgs.filter((m): m is TickMsg => m.t === 'tick' && m.roundId === roundId);
  }
}

let server: RunningServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('WebSocket gateway', () => {
  it('two clients in the same room see identical removals, multipliers and counts', async () => {
    const audit = new MemoryAuditLog();
    server = await startServer({ config: FAST, audit });
    const a = new Client(server.port);
    const b = new Client(server.port);
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'join', nickname: 'alice' });
    b.send({ t: 'join', nickname: 'bob' });
    const wa = await a.wait<Extract<ServerMessage, { t: 'welcome' }>>((m) => m.t === 'welcome');
    const wb = await b.wait<Extract<ServerMessage, { t: 'welcome' }>>((m) => m.t === 'welcome');
    expect(wa.roomId).toBe(wb.roomId);
    expect(wa.balance).toBe(100_000);

    // Wait for a fresh betting phase so both can bet.
    const state = await a.wait<Extract<ServerMessage, { t: 'roundState' }>>((m) => m.t === 'roundState' && m.phase === 'betting');
    a.send({ t: 'bet', amount: 100, tileId: 10 });
    b.send({ t: 'bet', amount: 250, tileId: 10 });
    expect(await a.wait((m) => m.t === 'betResult')).toMatchObject({ ok: true });
    expect(await b.wait((m) => m.t === 'betResult')).toMatchObject({ ok: true });
    b.send({ t: 'move', tileId: 20 });
    await b.wait((m) => m.t === 'moveResult');

    await a.wait((m) => m.t === 'roundEnd' && m.roundId === state.roundId, 30_000);
    await b.wait((m) => m.t === 'roundEnd' && m.roundId === state.roundId, 30_000);
    const ta = a.ticks(state.roundId).map((t) => [t.stage, t.tileGone, t.multiplier, t.removedCount]);
    const tb = b.ticks(state.roundId).map((t) => [t.stage, t.tileGone, t.multiplier, t.removedCount]);
    expect(ta.length).toBeGreaterThan(0);
    expect(ta).toEqual(tb);

    // Same broadcast stream: identical seq-ordered room messages from the first common seq.
    const stream = (c: Client) =>
      c.msgs.filter((m) => 'seq' in m && m.t !== 'roundState').map((m) => JSON.stringify(m));
    const sa = stream(a);
    const sb = stream(b);
    const common = sa.filter((x) => sb.includes(x));
    expect(common.length).toBeGreaterThan(ta.length);

    // Seq numbers are gap-free per client.
    for (const c of [a, b]) {
      const seqs = c.msgs.filter((m) => 'seq' in m).map((m) => (m as { seq: number }).seq);
      seqs.slice(1).forEach((s, i) => expect([0, 1]).toContain(s - seqs[i]));
    }

    const end = await a.wait<Extract<ServerMessage, { t: 'roundEnd' }>>((m) => m.t === 'roundEnd' && m.roundId === state.roundId);
    const rec = audit.rounds.find((r) => r.roundId === state.roundId)!;
    expect(rec.serverSeed).toBe(end.serverSeed);
    expect(checkRecord(rec)).toEqual([]);
    a.ws.close();
    b.ws.close();
  });

  it('rate-limits moves to 5/s per socket and rejects unknown/malformed input', async () => {
    server = await startServer({ config: { ...FAST, bettingMs: 5_000 } });
    const c = new Client(server.port);
    await c.open();
    c.send({ t: 'join', nickname: 'mover' });
    await c.wait((m) => m.t === 'welcome');
    c.send({ t: 'bet', amount: 100, tileId: 0 });
    await c.wait((m) => m.t === 'betResult');
    for (let i = 0; i < 12; i++) c.send({ t: 'move', tileId: 1 + i });
    await new Promise((r) => setTimeout(r, 300));
    const results = c.msgs.filter((m) => m.t === 'moveResult') as { ok: boolean; reason?: string }[];
    expect(results).toHaveLength(12);
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => r.reason === 'RATE_LIMIT').length).toBe(7);
    c.ws.send('not json');
    expect(await c.wait((m) => m.t === 'error')).toMatchObject({ code: 'BAD_REQUEST' });
    c.ws.close();
  });

  it('actions before join are rejected; spectating another room works', async () => {
    server = await startServer({ config: { ...FAST, roomSoftCap: 1 } });
    const a = new Client(server.port);
    const b = new Client(server.port);
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'cashout' });
    expect(await a.wait((m) => m.t === 'error')).toMatchObject({ code: 'NOT_JOINED' });
    a.send({ t: 'join', nickname: 'one' });
    b.send({ t: 'join', nickname: 'two' });
    const w1 = await a.wait<Extract<ServerMessage, { t: 'welcome' }>>((m) => m.t === 'welcome');
    const w2 = await b.wait<Extract<ServerMessage, { t: 'welcome' }>>((m) => m.t === 'welcome');
    expect(w1.roomId).not.toBe(w2.roomId); // soft cap 1 -> second joiner gets a new room
    b.send({ t: 'spectate', roomId: w1.roomId });
    expect(await b.wait((m) => m.t === 'rooms' && m.watching === w1.roomId)).toMatchObject({ home: w2.roomId });
    a.ws.close();
    b.ws.close();
  });
});
