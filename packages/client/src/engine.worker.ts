/// <reference lib="webworker" />
import { LocalHost } from '@p3/engine';
import type { ClientMessage } from '@p3/shared';

/** The authoritative engine. Removal sequences live only in this worker until a round is revealed. */
const host = new LocalHost();
const endpoint = host.connect((msg) => postMessage(msg));
addEventListener('message', (e: MessageEvent<ClientMessage>) => endpoint.receive(e.data));
