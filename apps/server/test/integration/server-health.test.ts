/**
 * System health → the server PC (M6.2 part H) through the API, on a real PostgreSQL: owner only;
 * the backup service shows as running only with a fresh heartbeat; the server certificate and the
 * root CA with their levels; WAL archiving; the clock; the owner's UPS confirmation (audited); the
 * database's power-cut settings and the check after its start (part I); and the owner alerts,
 * raised once per problem per day.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupPaths, writeHeartbeat } from '@artepool/backup';
import type { ServerHealth } from '@artepool/shared/contracts';
import { createCa, issueServerCert, TLS_FILES, writeTlsFile } from '@artepool/tls';
import { raiseServerHealthAlerts } from '../../src/modules/health/service';
import { addOwnerWithTwoStep } from '../support/https';
import {
  addDevice,
  addUser,
  call,
  errorCode,
  openSession,
  startTestServer,
  type TestDevice,
  type TestServer,
} from '../support/server';

const NAMES = { dns: ['localhost'], ips: ['127.0.0.1'] };

let root: string;
let tlsDir: string;
let backupDir: string;
let server: TestServer;
let office: TestDevice;
let ownerToken: string;
let accountantToken: string;
let ca: { certPem: string; keyPem: string };

/** A server certificate from the test CA, valid for `days`. */
async function serverCertificate(days: number) {
  const cert = await issueServerCert(ca, NAMES, days);
  await writeTlsFile(tlsDir, TLS_FILES.serverCert, cert.certPem);
  await writeTlsFile(tlsDir, TLS_FILES.serverKey, cert.keyPem);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'artepool-health-'));
  tlsDir = join(root, 'tls');
  backupDir = join(root, 'backups');
  await mkdir(backupDir);
  ca = await createCa(NAMES);
  await writeTlsFile(tlsDir, TLS_FILES.caCert, ca.certPem);
  await serverCertificate(730);
  server = await startTestServer(undefined, {
    backup: { ...backupPaths(), backupDir },
    health: { dataDir: root, tlsDir },
  });
  office = await addDevice(server, { code: 'OFFICE-01', kind: 'office' });
  const owner = await addOwnerWithTwoStep(server, { username: 'owner.main' });
  ownerToken = (
    await openSession(server, { userId: owner.id, deviceId: office.id, method: 'password_totp' })
  ).token;
  const accountant = await addUser(server, { username: 'khaled.acc', roles: ['accountant'] });
  accountantToken = (await openSession(server, { userId: accountant, deviceId: office.id })).token;
}, 120_000);
afterAll(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const get = (token = ownerToken) =>
  call(server, 'GET', '/api/v1/system/server-health', { device: office, token });
const health = async () => (await get()).json<ServerHealth>();
const confirmUps = (token = ownerToken) =>
  call(server, 'POST', '/api/v1/system/server-health/ups', {
    device: office,
    token,
    body: {},
    idempotencyKey: randomUUID(),
  });

describe('the server PC in System health', () => {
  it('is for the owner only', async () => {
    expect(errorCode(await get(accountantToken))).toBe('PERMISSION_DENIED');
    expect(errorCode(await confirmUps(accountantToken))).toBe('PERMISSION_DENIED');
  });

  it('shows the disks, the clock and WAL archiving', async () => {
    const h = await health();
    expect(h.disks.map((d) => d.disk)).toEqual(['data', 'backups', 'system']);
    for (const d of h.disks) {
      expect(d.totalBytes).toBeGreaterThan(0);
      expect(['ok', 'warning', 'urgent']).toContain(d.level);
    }
    expect(h.clock.isBehind).toBe(false);
    // The test database has no WAL archiving (the installed server PC has).
    expect(h.wal).toMatchObject({ enabled: false, failing: false });
  });

  it('shows the database start, its power-cut settings and the check after the start (part I)', async () => {
    let h = await health();
    expect(Date.parse(h.database.startedAt)).toBeLessThan(Date.now());
    // The test database runs with them all on (wal_sync_method is checked on Windows only).
    expect(h.database.durability).toEqual({ ok: true, off: [] });
    expect(h.database.startCheck).toBeNull();
    expect(h.problems).not.toContain('durability_off');

    const run = async (status: 'ok' | 'issues') => {
      await server.admin.query('BEGIN');
      await server.admin.query("SELECT sys.set_context(1, p_reason => 'test: backup service')");
      await server.admin.query(
        `INSERT INTO ops.integrity_runs (run_kind, database_name, finished_at, status)
         VALUES ('after_start', current_database(), now(), $1)`,
        [status],
      );
      await server.admin.query('COMMIT');
    };
    await run('issues');
    h = await health();
    expect(h.database.startCheck).toMatchObject({ status: 'issues' });
    expect(h.problems).toContain('start_check_failed');
    await run('ok');
    h = await health();
    expect(h.database.startCheck).toMatchObject({ status: 'ok' });
    expect(h.problems).not.toContain('start_check_failed');
  });

  it('shows the backup service as running only with a fresh heartbeat', async () => {
    let h = await health();
    expect(h.services).toEqual({ backupHeartbeatAt: null, backupRunning: false });
    expect(h.problems).toContain('backup_service_down');
    await writeHeartbeat(backupDir, new Date(Date.now() - 10 * 60_000));
    h = await health();
    expect(h.services.backupRunning).toBe(false);
    await writeHeartbeat(backupDir);
    h = await health();
    expect(h.services.backupRunning).toBe(true);
    expect(h.problems).not.toContain('backup_service_down');
  });

  it('shows the certificates with their levels', async () => {
    let h = await health();
    expect(h.certificate.server).toMatchObject({ level: 'ok' });
    expect(h.certificate.server!.daysLeft).toBeGreaterThanOrEqual(729);
    expect(h.certificate.rootCa).toMatchObject({ level: 'ok' });
    expect(h.certificate.rootCa!.daysLeft).toBeGreaterThan(7000);
    expect(h.problems).not.toContain('certificate_expiring');

    await serverCertificate(30);
    h = await health();
    expect(h.certificate.server).toMatchObject({ level: 'warning' });
    expect(h.problems).toContain('certificate_expiring');

    await serverCertificate(10);
    h = await health();
    expect(h.certificate.server).toMatchObject({ level: 'urgent' });

    await serverCertificate(730);
    expect((await health()).problems).not.toContain('certificate_expiring');
  });

  it('asks for the UPS until the owner confirms it, and audits the confirmation', async () => {
    let h = await health();
    expect(h.ups).toMatchObject({ confirmedAt: null, due: true, reminderDays: 182 });
    expect(h.problems).toContain('ups_unconfirmed');
    const res = await confirmUps();
    expect(res.statusCode).toBe(200);
    h = await health();
    expect(h.ups.due).toBe(false);
    expect(h.problems).not.toContain('ups_unconfirmed');
    const { rows } = await server.admin.query<{ reason: string }>(
      `SELECT reason FROM audit.log WHERE entity_type = 'ops.server_health' AND action = 'update'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.reason).toMatch(/UPS/);
  });

  it('shows a failed renewal until a renewal succeeds', async () => {
    const set = async (values: string) => {
      await server.admin.query('BEGIN');
      await server.admin.query("SELECT sys.set_context(1, p_reason => 'test: updater')");
      await server.admin.query(`UPDATE ops.server_health SET ${values} WHERE id = 1`);
      await server.admin.query('COMMIT');
    };
    await set(`cert_renew_attempted_at = now(), cert_renew_error = 'the check failed'`);
    let h = await health();
    expect(h.certificate.renewalError).toBe('the check failed');
    expect(h.problems).toContain('certificate_renewal_failed');
    await set(`cert_renewed_at = now(), cert_renew_error = NULL`);
    h = await health();
    expect(h.problems).not.toContain('certificate_renewal_failed');
    expect(h.certificate.lastRenewedAt).not.toBeNull();
  });

  it('raises one owner alert per problem per day', async () => {
    await rm(join(backupDir, '.heartbeat'), { force: true });
    await raiseServerHealthAlerts(server.deps);
    await raiseServerHealthAlerts(server.deps);
    const { rows } = await server.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM sys.alerts WHERE alert_type = 'service_down'`,
    );
    expect(rows[0]!.n).toBe('1');
  });
});
