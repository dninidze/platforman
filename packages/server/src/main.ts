import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { FileAuditLog } from './audit';
import { loadConfig } from './config';
import { startServer } from './gateway';

const appRoot = fileURLToPath(new URL('../../../', import.meta.url));
const config = loadConfig(process.env, {});
const dataDir = resolve(appRoot, process.env.DATA_DIR ?? config.dataDir);
const audit = new FileAuditLog(dataDir);

const server = await startServer({
  config,
  audit,
  staticDir: resolve(appRoot, 'packages/client/dist'),
});

console.log(
  `[p3] server on http://localhost:${server.port}  ws: /ws  data: ${dataDir}  ` +
    `tick=${config.tickMs}ms betting=${config.bettingMs}ms softCap=${config.roomSoftCap}`,
);

const shutdown = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
