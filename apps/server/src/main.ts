/** ARTÉPOOL API service entry point: HTTPS (TLS 1.3 only) with the ARTÉPOOL CA certificate. */
import { readServerTls } from '@artepool/tls';
import { buildApp } from './app';
import { loadConfig } from './platform/config';
import { SecretBox } from './platform/crypto/secret-box';
import { createDb, createPool } from './platform/db/pool';
import { createDeps } from './platform/http/deps';
import { raiseBackupAlerts } from './modules/backup/service';
import { ensurePeriods } from './modules/ledger/periods';

const config = loadConfig();
const [secretBox, tls] = await Promise.all([
  SecretBox.fromFile(config.masterKeyFile),
  readServerTls(config.tlsDir),
]);
const pool = createPool(config.database);
const db = createDb(pool);
const deps = createDeps({ db, secretBox, caCertificatePem: tls.caCertPem });
const app = buildApp({ ...config, https: { cert: tls.certPem, key: tls.keyPem } }, deps);

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

/** A late or failed backup alerts the owner (decision 0086): checked every 5 minutes. */
async function checkBackups(): Promise<void> {
  try {
    await raiseBackupAlerts(deps);
  } catch (error) {
    app.log.error({ err: error }, 'could not check the backups');
  }
}
const backupTimer = setInterval(() => void checkBackups(), 5 * 60 * 1000);
backupTimer.unref();

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, stopping`);
  clearInterval(periodsTimer);
  clearInterval(backupTimer);
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
