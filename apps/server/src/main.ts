/** ARTÉPOOL API service entry point: HTTPS (TLS 1.3 only) with the ARTÉPOOL CA certificate. */
import { readServerTls } from '@artepool/tls';
import { buildApp } from './app';
import { loadConfig } from './platform/config';
import { SecretBox } from './platform/crypto/secret-box';
import { createDb, createPool } from './platform/db/pool';
import { createDeps } from './platform/http/deps';

const config = loadConfig();
const [secretBox, tls] = await Promise.all([
  SecretBox.fromFile(config.masterKeyFile),
  readServerTls(config.tlsDir),
]);
const pool = createPool(config.database);
const db = createDb(pool);
const app = buildApp(
  { ...config, https: { cert: tls.certPem, key: tls.keyPem } },
  createDeps({ db, secretBox, caCertificatePem: tls.caCertPem }),
);

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
