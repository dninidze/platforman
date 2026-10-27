import type { ClientMessage, ServerMessage } from '@p3/shared';

/**
 * How the UI talks to the game engine. The UI only ever sends §8 client messages and renders §8 server
 * messages; which side of which boundary the engine lives on is a transport detail:
 * - WorkerTransport: the engine runs in an inlined Web Worker (default, works from file://).
 * - InProcessTransport: the engine runs on the main thread (fallback when workers are unavailable).
 * - WebSocketTransport: a real server (kept for later; not used by the offline build).
 */
export interface Transport {
  readonly kind: string;
  send(msg: ClientMessage): void;
  onMessage(cb: (msg: ServerMessage) => void): void;
  /** Called with true once the engine is reachable and false if it goes away. */
  onStatus(cb: (up: boolean) => void): void;
  close(): void;
}

abstract class BaseTransport implements Transport {
  abstract readonly kind: string;
  protected msgCb: (msg: ServerMessage) => void = () => {};
  protected statusCb: (up: boolean) => void = () => {};
  abstract send(msg: ClientMessage): void;
  abstract close(): void;
  onMessage(cb: (msg: ServerMessage) => void): void {
    this.msgCb = cb;
  }
  onStatus(cb: (up: boolean) => void): void {
    this.statusCb = cb;
  }
}

export class WorkerTransport extends BaseTransport {
  readonly kind = 'web worker';
  private readonly worker: Worker;

  constructor(make: () => Worker, onFail: (err: unknown) => void) {
    super();
    this.worker = make();
    this.worker.onmessage = (e: MessageEvent<ServerMessage>) => this.msgCb(e.data);
    this.worker.onerror = (e) => {
      this.statusCb(false);
      onFail(e);
    };
    queueMicrotask(() => this.statusCb(true));
  }
  send(msg: ClientMessage): void {
    this.worker.postMessage(msg);
  }
  close(): void {
    this.worker.terminate();
  }
}

/** Minimal shape of the engine host, so this module does not import the engine eagerly. */
interface HostLike {
  connect(send: (msg: ServerMessage) => void): { receive(msg: ClientMessage): void; close(): void };
  shutdown(): void;
}

export class InProcessTransport extends BaseTransport {
  readonly kind = 'main thread';
  private endpoint: { receive(msg: ClientMessage): void; close(): void } | null = null;
  private queue: ClientMessage[] = [];

  constructor(private readonly host: Promise<HostLike>) {
    super();
    void host.then((h) => {
      // Messages cross an async boundary in both directions, as they would through a worker.
      this.endpoint = h.connect((msg) => queueMicrotask(() => this.msgCb(structuredClone(msg))));
      this.statusCb(true);
      for (const m of this.queue.splice(0)) this.endpoint.receive(m);
    });
  }
  send(msg: ClientMessage): void {
    const copy = structuredClone(msg);
    if (this.endpoint) queueMicrotask(() => this.endpoint!.receive(copy));
    else this.queue.push(copy);
  }
  close(): void {
    this.endpoint?.close();
    void this.host.then((h) => h.shutdown());
  }
}

export class WebSocketTransport extends BaseTransport {
  readonly kind = 'websocket';
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;

  constructor(private readonly url: string) {
    super();
    this.open();
  }
  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.statusCb(true);
    };
    ws.onclose = () => {
      this.statusCb(false);
      if (!this.closed && this.ws === ws) setTimeout(() => this.open(), Math.min(5_000, 500 * 2 ** this.retry++));
    };
    ws.onmessage = (ev) => this.msgCb(JSON.parse(ev.data as string) as ServerMessage);
  }
  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
