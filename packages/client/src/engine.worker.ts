/// <reference lib="webworker" />
import { LocalHost, type HostEndpoint } from '@p3/engine';
import type { ClientMessage } from '@p3/shared';

/**
 * The authoritative engine. Removal sequences live only in this worker until a round is revealed.
 * The page's first message is `__init` (currency from the player session); the engine starts then.
 */
let endpoint: HostEndpoint | null = null;
const early: ClientMessage[] = [];
addEventListener('message', (e: MessageEvent<ClientMessage | { t: '__init'; currency: string }>) => {
  const m = e.data;
  if (m.t === '__init') {
    if (endpoint) return;
    const host = new LocalHost({ config: { currency: m.currency } });
    endpoint = host.connect((msg) => postMessage(msg));
    for (const q of early.splice(0)) endpoint.receive(q);
  } else if (endpoint) endpoint.receive(m);
  else early.push(m);
});
