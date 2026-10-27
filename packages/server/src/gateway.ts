import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  RealClock,
  type BroadcastMessage,
  type ClientMessage,
  type Clock,
  type ErrorCode,
  type ServerMessage,
} from '@p3/shared';
import { FileAuditLog, MemoryAuditLog, type AuditLog } from './audit';
import { publicConfig, type ServerConfig } from './config';
import type { Room } from './room';
import { RoomManager } from './roomManager';
import { MockWallet, type Wallet } from './wallet';

/** Skip room broadcasts to a socket with this much unsent data; the client resyncs on the seq gap. */
const MAX_BUFFERED = 1 << 20;
const NICK_RE = /^[A-Za-z0-9_-]{1,16}$/;

class Bucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

interface Conn {
  id: number;
  ws: WebSocket;
  playerId: string | null;
  nickname: string | null;
  watching: string | null;
  moves: Bucket;
  msgs: Bucket;
}

export interface Metrics {
  connections: number;
  bytesOut: number;
  msgsOut: number;
  broadcastsDropped: number;
  actions: number;
  startedAt: number;
}

export interface ServerOptions {
  config: ServerConfig;
  clock?: Clock;
  wallet?: Wallet;
  audit?: AuditLog;
  staticDir?: string;
  seedSource?: () => string;
}

export interface RunningServer {
  port: number;
  manager: RoomManager;
  metrics: Metrics;
  close(): Promise<void>;
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { config } = opts;
  const clock = opts.clock ?? new RealClock();
  const wallet = opts.wallet ?? new MockWallet(config.startingBalance, config.currency);
  const audit = opts.audit ?? new MemoryAuditLog();
  const metrics: Metrics = { connections: 0, bytesOut: 0, msgsOut: 0, broadcastsDropped: 0, actions: 0, startedAt: Date.now() };
  const subscribers = new Map<string, Set<Conn>>();
  const players = new Map<string, Conn>();
  let nextConnId = 1;

  const sendRaw = (conn: Conn, data: string) => {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ws.send(data);
    metrics.bytesOut += data.length;
    metrics.msgsOut++;
  };
  const send = (conn: Conn, msg: ServerMessage) => sendRaw(conn, JSON.stringify(msg));

  const manager = new RoomManager({
    config,
    clock,
    wallet,
    audit,
    seedSource: opts.seedSource,
    sink: {
      broadcast(roomId: string, msg: BroadcastMessage) {
        const subs = subscribers.get(roomId);
        if (!subs || subs.size === 0) return;
        const data = JSON.stringify(msg);
        for (const conn of subs) {
          if (conn.ws.bufferedAmount > MAX_BUFFERED) {
            metrics.broadcastsDropped++;
            continue;
          }
          sendRaw(conn, data);
        }
      },
      sendToPlayer(playerId: string, msg: ServerMessage) {
        const conn = players.get(playerId);
        if (conn) send(conn, msg);
      },
    },
    onRoomClosed(room: Room) {
      const subs = subscribers.get(room.id);
      subscribers.delete(room.id);
      for (const conn of subs ?? []) {
        conn.watching = null;
        const home = conn.playerId ? manager.roomOf(conn.playerId) : undefined;
        if (home) watch(conn, home);
      }
    },
  });

  const roomsMsg = (conn: Conn): ServerMessage => ({
    t: 'rooms',
    rooms: manager.list(),
    home: conn.playerId ? (manager.roomOf(conn.playerId)?.id ?? null) : null,
    watching: conn.watching,
  });

  function watch(conn: Conn, room: Room) {
    if (conn.watching) subscribers.get(conn.watching)?.delete(conn);
    conn.watching = room.id;
    let subs = subscribers.get(room.id);
    if (!subs) subscribers.set(room.id, (subs = new Set()));
    subs.add(conn);
    room.advance();
    send(conn, room.snapshot());
    send(conn, { ...room.liveFeed(), seq: room.seq });
    send(conn, roomsMsg(conn));
  }

  const err = (conn: Conn, code: ErrorCode, message: string, rid?: number) => {
    audit.rejected({ at: clock.now(), roomId: conn.watching, playerId: conn.playerId, action: 'message', code, detail: message });
    send(conn, { t: 'error', code, message, rid });
  };

  async function handle(conn: Conn, msg: ClientMessage) {
    const now = clock.now();
    if (msg.t === 'ping') return send(conn, { t: 'pong', at: msg.at, serverTime: now });
    if (!conn.msgs.take(now)) return err(conn, 'RATE_LIMIT', 'too many messages', 'rid' in msg ? msg.rid : undefined);

    switch (msg.t) {
      case 'join': {
        const nickname = String(msg.nickname ?? '').trim();
        if (!NICK_RE.test(nickname)) return err(conn, 'BAD_REQUEST', 'nickname: 1-16 letters, digits, _ or -', msg.rid);
        if (msg.currency && msg.currency !== config.currency) return err(conn, 'BAD_REQUEST', `currency ${msg.currency} not offered`, msg.rid);
        const playerId = `p:${nickname.toLowerCase()}`;
        if (conn.playerId && conn.playerId !== playerId) return err(conn, 'BAD_REQUEST', 'already joined', msg.rid);
        const old = players.get(playerId);
        if (old && old !== conn) {
          send(old, { t: 'error', code: 'BAD_REQUEST', message: 'This nickname connected from another tab.' });
          old.playerId = null;
          old.ws.close(4000, 'replaced');
        }
        conn.playerId = playerId;
        conn.nickname = nickname;
        players.set(playerId, conn);
        const room = manager.join(playerId, nickname, config.currency);
        const balance = await wallet.getBalance(playerId, config.currency);
        send(conn, {
          t: 'welcome',
          playerId,
          nickname,
          roomId: room.id,
          balance,
          config: publicConfig(config),
          rooms: manager.list(),
        });
        watch(conn, room);
        send(conn, room.youFor(playerId, balance));
        return;
      }
      case 'spectate': {
        const room = manager.get(String(msg.roomId));
        if (!room) return err(conn, 'NO_ROOM', 'no such room', msg.rid);
        return watch(conn, room);
      }
      case 'resync': {
        const room = conn.watching ? manager.get(conn.watching) : undefined;
        if (room) send(conn, room.snapshot());
        return;
      }
    }

    const playerId = conn.playerId;
    const room = playerId ? manager.roomOf(playerId) : undefined;
    if (!playerId || !room) return err(conn, 'NOT_JOINED', 'join first', 'rid' in msg ? msg.rid : undefined);
    metrics.actions++;
    switch (msg.t) {
      case 'bet': {
        const r = await room.bet(playerId, Number(msg.amount), Number(msg.tileId));
        return send(conn, r.ok ? { t: 'betResult', rid: msg.rid, ok: true, amount: r.amount, tileId: r.tileId } : { t: 'betResult', rid: msg.rid, ok: false, reason: r.reason });
      }
      case 'cancelBet': {
        const r = await room.cancelBet(playerId);
        return send(conn, r.ok ? { t: 'cancelResult', rid: msg.rid, ok: true } : { t: 'cancelResult', rid: msg.rid, ok: false, reason: r.reason });
      }
      case 'move': {
        if (!conn.moves.take(now)) {
          audit.rejected({ at: now, roomId: room.id, playerId, action: 'move', code: 'RATE_LIMIT' });
          return send(conn, { t: 'moveResult', rid: msg.rid, ok: false, reason: 'RATE_LIMIT' });
        }
        const r = room.move(playerId, Number(msg.tileId));
        return send(conn, r.ok ? { t: 'moveResult', rid: msg.rid, ok: true, tileId: r.tileId } : { t: 'moveResult', rid: msg.rid, ok: false, reason: r.reason });
      }
      case 'cashout': {
        const r = room.cashout(playerId);
        return send(
          conn,
          r.ok
            ? { t: 'cashoutResult', rid: msg.rid, ok: true, amount: r.amount, multiplier: r.multiplier, maxWin: r.maxWin }
            : { t: 'cashoutResult', rid: msg.rid, ok: false, reason: r.reason },
        );
      }
      default:
        return err(conn, 'BAD_REQUEST', 'unknown message type');
    }
  }

  // ---------------------------------------------------------------- HTTP

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function http(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/metrics') {
      return json(res, 200, {
        ...metrics,
        connections: players.size,
        sockets: wss.clients.size,
        cpu: process.cpuUsage(),
        mem: process.memoryUsage(),
        uptimeS: process.uptime(),
        rooms: manager.list(),
        rejects: audit instanceof FileAuditLog ? audit.rejectCounts : undefined,
      });
    }
    if (path === '/api/rooms') return json(res, 200, manager.list());
    if (path === '/api/history') {
      const room = manager.get(url.searchParams.get('roomId') ?? '');
      return json(res, room ? 200 : 404, room ? room.history : { error: 'no such room' });
    }
    if (path === '/api/rounds') {
      if (!(audit instanceof FileAuditLog)) return json(res, 200, []);
      const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 30));
      const rows = audit.recentRounds(url.searchParams.get('roomId') ?? undefined, limit).map(({ players: _p, ticks: _t, ...rest }) => rest);
      return json(res, 200, rows);
    }
    if (path.startsWith('/api/rounds/')) {
      const id = decodeURIComponent(path.slice('/api/rounds/'.length));
      const rec = audit instanceof FileAuditLog ? await audit.findRound(id) : (audit as MemoryAuditLog).rounds.find((r) => r.roundId === id);
      return json(res, rec ? 200 : 404, rec ?? { error: 'round not found' });
    }
    if (opts.staticDir && existsSync(opts.staticDir)) return serveStatic(opts.staticDir, path, res);
    json(res, 404, { error: 'not found' });
  }

  const httpServer = createServer((req, res) => {
    http(req, res).catch((e) => json(res, 500, { error: String(e) }));
  });
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', perMessageDeflate: false, maxPayload: 4096 });

  wss.on('connection', (ws) => {
    const now = clock.now();
    const conn: Conn = {
      id: nextConnId++,
      ws,
      playerId: null,
      nickname: null,
      watching: null,
      moves: new Bucket(config.movesPerSecond, config.movesPerSecond, now),
      msgs: new Bucket(30, 60, now),
    };
    metrics.connections++;
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
        if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') throw new Error('bad');
      } catch {
        return err(conn, 'BAD_REQUEST', 'malformed message');
      }
      handle(conn, msg).catch((e) => {
        audit.event('handler_error', { error: String(e?.stack ?? e) });
        send(conn, { t: 'error', code: 'BAD_REQUEST', message: 'internal error' });
      });
    });
    ws.on('close', () => {
      metrics.connections--;
      if (conn.watching) subscribers.get(conn.watching)?.delete(conn);
      if (conn.playerId && players.get(conn.playerId) === conn) {
        players.delete(conn.playerId);
        manager.leave(conn.playerId);
      }
    });
    ws.on('error', () => {});
  });

  return new Promise((resolve) => {
    httpServer.listen(config.port, () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : config.port;
      resolve({
        port,
        manager,
        metrics,
        close: () =>
          new Promise<void>((done) => {
            manager.shutdown();
            for (const c of wss.clients) c.terminate();
            wss.close();
            httpServer.close(() => done());
          }),
      });
    });
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(root: string, path: string, res: ServerResponse) {
  let file = normalize(join(root, path));
  if (!file.startsWith(normalize(root)) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}
