/** ARTÉPOOL API service entry point: HTTPS (TLS 1.3 only) with the ARTÉPOOL CA certificate. */
import { readServerTls } from '@artepool/tls';
import { buildApp } from './app';
import { loadConfig } from './platform/config';
import { SecretBox } from './platform/crypto/secret-box';
import { createDb, createPool } from './platform/db/pool';
import { createDeps } from './platform/http/deps';
import { raiseBackupAlerts } from './modules/backup/service';
import { raiseServerHealthAlerts } from './modules/health/service';
import { ensurePeriods } from './modules/ledger/periods';
import { raiseClockAlert } from './platform/time/clock-guard';

const config = loadConfig();
const [secretBox, tls] = await Promise.all([
  SecretBox.fromSource(config.masterKey),
  readServerTls(config.tlsDir),
]);
const pool = createPool(config.database);
const db = createDb(pool);
const deps = createDeps({
  db,
  secretBox,
  caCertificatePem: tls.caCertPem,
  health: { dataDir: config.dataDir, tlsDir: config.tlsDir },
});
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

/**
 * A late or failed backup (decision 0086) and a problem with the server PC (M6.2 part H: disks,
 * the backup service, WAL archiving, certificates, the UPS) alert the owner: checked every 5
 * minutes.
 */
async function checkBackups(): Promise<void> {
  try {
    await raiseBackupAlerts(deps);
  } catch (error) {
    app.log.error({ err: error }, 'could not check the backups');
  }
  try {
    await raiseServerHealthAlerts(deps);
  } catch (error) {
    app.log.error({ err: error }, 'could not check the server PC health');
  }
}
const backupTimer = setInterval(() => void checkBackups(), 5 * 60 * 1000);
backupTimer.unref();

/**
 * The server clock went back behind the latest record (migration 0043): writes are refused and
 * the owner is alerted. Checked at start-up and every 5 minutes.
 */
async function checkClock(): Promise<void> {
  try {
    const status = await raiseClockAlert(db);
    if (status.isBehind) {
      app.log.error(
        { serverTime: status.serverTime, latestRecordAt: status.latestRecordAt },
        'the server clock is behind the latest record: check the Windows time',
      );
    }
  } catch (error) {
    app.log.error({ err: error }, 'could not check the server clock');
  }
}
const clockTimer = setInterval(() => void checkClock(), 5 * 60 * 1000);
clockTimer.unref();

async function shutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received, stopping`);
  clearInterval(periodsTimer);
  clearInterval(backupTimer);
  clearInterval(clockTimer);
  await app.close();
  await db.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  await checkClock();
  await keepPeriodsAhead();
} catch (error) {
  app.log.fatal({ err: error }, 'server failed to start');
  process.exit(1);
}
