/** ARTÉPOOL API service entry point. In M0 it only serves GET /health on localhost. */
import { buildApp } from './app';
import { loadConfig } from './platform/config';
import { createDb, createPool } from './platform/db/pool';

const config = loadConfig();
const pool = createPool(config.database);
const db = createDb(pool);
const app = buildApp(config, db);

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, stopping`);
  await app.close();
  await db.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'server failed to start');
  process.exit(1);
}
