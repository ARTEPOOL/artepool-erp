/** ARTÉPOOL API service entry point: HTTPS (TLS 1.3 only) with the ARTÉPOOL CA certificate. */
import { readServerTls } from '@artepool/tls';
import { buildApp } from './app';
import { loadConfig } from './platform/config';
import { SecretBox } from './platform/crypto/secret-box';
import { createDb, createPool } from './platform/db/pool';
import { createDeps } from './platform/http/deps';
import { ensurePeriods } from './modules/ledger/periods';

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

/** Accounting months always exist 3 months ahead (decision 0016): at start-up and every 6 hours. */
async function keepPeriodsAhead(): Promise<void> {
  try {
    const created = await ensurePeriods(db);
    if (created > 0) app.log.info({ created }, 'accounting months added');
  } catch (error) {
    app.log.error({ err: error }, 'could not add the next accounting months');
  }
}
const periodsTimer = setInterval(() => void keepPeriodsAhead(), 6 * 60 * 60 * 1000);
periodsTimer.unref();

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, stopping`);
  clearInterval(periodsTimer);
  await app.close();
  await db.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  await keepPeriodsAhead();
} catch (error) {
  app.log.fatal({ err: error }, 'server failed to start');
  process.exit(1);
}
