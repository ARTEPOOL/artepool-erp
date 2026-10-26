/**
 * The server PC's health (M6.2 part H): disk space where the database, the backups and Windows
 * live; whether the backup service is running (its heartbeat) and WAL archiving works; the server
 * certificate and the root CA with their expiry dates; the server clock; and the owner's UPS
 * confirmation. The server's check every few minutes raises one alert per problem per day.
 */
import { randomUUID, X509Certificate } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Transaction } from 'kysely';
import { HEARTBEAT_STALE_MS, readHeartbeat } from '@artepool/backup';
import type {
  CertificateInfo,
  DiskInfo,
  HealthLevel,
  ServerDisk,
  ServerHealth,
  ServerHealthProblem,
} from '@artepool/shared/contracts';
import { TLS_FILES } from '@artepool/tls';
import { withBusinessTx } from '../../platform/db/tx';
import type { DB } from '../../platform/db/schema.generated';
import type { AppDeps } from '../../platform/http/deps';
import { clockStatus } from '../../platform/time/clock-guard';
import { dubaiDate } from '../../platform/time';

const GB = 1024 ** 3;
const DAY = 24 * 3600 * 1000;

/** Warning under 10% or 10 GB free; urgent under 5% or 2 GB. */
export function diskLevel(freeBytes: number, totalBytes: number): HealthLevel {
  if (freeBytes < 2 * GB || freeBytes < totalBytes * 0.05) return 'urgent';
  if (freeBytes < 10 * GB || freeBytes < totalBytes * 0.1) return 'warning';
  return 'ok';
}

/**
 * The server certificate renews itself 60 days before it ends (part H3): orange from 60 days
 * (the renewal is late or failing), red from 14. The root CA is renewed by hand, with the
 * owner's approval, so it warns much earlier: orange from two years, red from six months.
 */
export const CERT_LEVELS = { warningDays: 60, urgentDays: 14 } as const;
export const ROOT_CA_LEVELS = { warningDays: 730, urgentDays: 180 } as const;

export function certificateLevel(
  daysLeft: number,
  levels: { warningDays: number; urgentDays: number },
): HealthLevel {
  if (daysLeft <= levels.urgentDays) return 'urgent';
  if (daysLeft <= levels.warningDays) return 'warning';
  return 'ok';
}

/** The owner confirms the UPS again after this many days (decision 0085). */
export const UPS_REMINDER_DAYS = 182;

export function upsDue(confirmedAt: Date | null, now: number): boolean {
  return confirmedAt === null || now - confirmedAt.getTime() > UPS_REMINDER_DAYS * DAY;
}

/** The system drive: where Windows lives (the root on a development PC). */
function systemDrive(): string {
  return process.platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/';
}

async function disk(name: ServerDisk, path: string): Promise<DiskInfo | null> {
  try {
    const s = await statfs(path);
    const freeBytes = s.bavail * s.bsize;
    const totalBytes = s.blocks * s.bsize;
    return { disk: name, path, freeBytes, totalBytes, level: diskLevel(freeBytes, totalBytes) };
  } catch {
    return null;
  }
}

async function certificate(
  file: string,
  levels: { warningDays: number; urgentDays: number },
  now: number,
): Promise<CertificateInfo | null> {
  try {
    const cert = new X509Certificate(await readFile(file));
    const expires = new Date(cert.validTo);
    const daysLeft = Math.floor((expires.getTime() - now) / DAY);
    return {
      expiresAt: expires.toISOString(),
      daysLeft,
      level: certificateLevel(daysLeft, levels),
    };
  } catch {
    return null;
  }
}

async function walArchiving(deps: AppDeps): Promise<ServerHealth['wal']> {
  const { rows } = await sql<{
    mode: string;
    last_archived_time: Date | null;
    last_failed_time: Date | null;
  }>`SELECT current_setting('archive_mode') AS mode, last_archived_time, last_failed_time
       FROM pg_stat_archiver`.execute(deps.db);
  const row = rows[0];
  const enabled = row !== undefined && row.mode !== 'off';
  const lastArchived = row?.last_archived_time ?? null;
  const lastFailed = row?.last_failed_time ?? null;
  return {
    enabled,
    lastArchivedAt: lastArchived?.toISOString() ?? null,
    lastFailedAt: lastFailed?.toISOString() ?? null,
    failing:
      enabled &&
      lastFailed !== null &&
      (lastArchived === null || lastFailed.getTime() > lastArchived.getTime()),
  };
}

export async function serverHealth(deps: AppDeps, now = Date.now()): Promise<ServerHealth> {
  const { dataDir, tlsDir } = deps.health;
  const [data, backups, system, heartbeat, wal, server, rootCa, clock, row] = await Promise.all([
    disk('data', dataDir),
    disk('backups', deps.backup.backupDir),
    disk('system', systemDrive()),
    readHeartbeat(deps.backup.backupDir),
    walArchiving(deps),
    certificate(join(tlsDir, TLS_FILES.serverCert), CERT_LEVELS, now),
    certificate(join(tlsDir, TLS_FILES.caCert), ROOT_CA_LEVELS, now),
    clockStatus(deps.db),
    deps.db
      .selectFrom('ops.server_health')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow(),
  ]);
  const disks = [data, backups, system].filter((d): d is DiskInfo => d !== null);
  const backupRunning = heartbeat !== null && now - heartbeat.getTime() <= HEARTBEAT_STALE_MS;
  const ups = { confirmedAt: row.ups_confirmed_at, due: upsDue(row.ups_confirmed_at, now) };

  const problems = new Set<ServerHealthProblem>();
  if (disks.some((d) => d.level === 'urgent')) problems.add('disk_urgent');
  else if (disks.some((d) => d.level === 'warning')) problems.add('disk_low');
  if (!backupRunning) problems.add('backup_service_down');
  if (wal.failing) problems.add('wal_archive_failed');
  if (server && server.level !== 'ok') problems.add('certificate_expiring');
  if (row.cert_renew_error !== null) problems.add('certificate_renewal_failed');
  if (rootCa && rootCa.level !== 'ok') problems.add('root_ca_expiring');
  if (clock.isBehind) problems.add('clock_behind');
  if (ups.due) problems.add('ups_unconfirmed');

  return {
    problems: [...problems],
    disks,
    services: { backupHeartbeatAt: heartbeat?.toISOString() ?? null, backupRunning },
    wal,
    certificate: {
      server,
      rootCa,
      lastRenewedAt: row.cert_renewed_at?.toISOString() ?? null,
      lastAttemptAt: row.cert_renew_attempted_at?.toISOString() ?? null,
      renewalError: row.cert_renew_error,
    },
    clock: {
      serverTime: clock.serverTime.toISOString(),
      latestRecordAt: clock.latestRecordAt?.toISOString() ?? null,
      isBehind: clock.isBehind,
    },
    ups: {
      confirmedAt: ups.confirmedAt?.toISOString() ?? null,
      due: ups.due,
      reminderDays: UPS_REMINDER_DAYS,
    },
  };
}

/** The owner confirms a UPS is connected to the server PC (asked again after six months). */
export async function confirmUps(trx: Transaction<DB>): Promise<{ confirmedAt: string }> {
  const row = await trx
    .updateTable('ops.server_health')
    .set({ ups_confirmed_at: sql<Date>`now()` })
    .where('id', '=', 1)
    .returning('ups_confirmed_at')
    .executeTakeFirstOrThrow();
  return { confirmedAt: row.ups_confirmed_at!.toISOString() };
}

type Alert = {
  type: string;
  severity: 'info' | 'warning' | 'critical';
  which: string;
  params?: Record<string, unknown>;
};

/** The owner's alerts for the server PC's health (the clock has its own check). */
export function healthAlerts(health: ServerHealth): Alert[] {
  const alerts: Alert[] = [];
  for (const d of health.disks) {
    if (d.level === 'urgent') {
      alerts.push({
        type: 'disk_urgent',
        severity: 'critical',
        which: d.disk,
        params: diskParams(d),
      });
    } else if (d.level === 'warning') {
      alerts.push({ type: 'disk_low', severity: 'warning', which: d.disk, params: diskParams(d) });
    }
  }
  if (!health.services.backupRunning) {
    alerts.push({ type: 'service_down', severity: 'critical', which: 'backup' });
  }
  if (health.wal.failing)
    alerts.push({ type: 'wal_archive_failed', severity: 'warning', which: 'wal' });
  const { server, rootCa, renewalError } = health.certificate;
  if (server && server.level !== 'ok') {
    alerts.push({
      type: 'certificate_expiring',
      severity: server.level === 'urgent' ? 'critical' : 'warning',
      which: 'server',
      params: { expiresAt: server.expiresAt, daysLeft: server.daysLeft },
    });
  }
  if (renewalError !== null) {
    alerts.push({ type: 'certificate_renewal_failed', severity: 'warning', which: 'server' });
  }
  if (rootCa && rootCa.level !== 'ok') {
    alerts.push({
      type: 'root_ca_expiring',
      severity: rootCa.level === 'urgent' ? 'critical' : 'warning',
      which: 'root_ca',
      params: { expiresAt: rootCa.expiresAt, daysLeft: rootCa.daysLeft },
    });
  }
  if (health.ups.due) alerts.push({ type: 'ups_unconfirmed', severity: 'info', which: 'ups' });
  return alerts;
}

const diskParams = (d: DiskInfo) => ({ freeBytes: d.freeBytes, totalBytes: d.totalBytes });

/** One alert per problem per day (Dubai), like the backup alerts; checked every few minutes. */
export async function raiseServerHealthAlerts(deps: AppDeps, now = Date.now()): Promise<number> {
  const alerts = healthAlerts(await serverHealth(deps, now));
  if (alerts.length === 0) return 0;
  const day = dubaiDate(new Date(now));
  await withBusinessTx(
    deps.db,
    { userId: 1n, requestId: randomUUID(), reason: 'server health check' },
    async (trx) => {
      for (const a of alerts) {
        await sql`INSERT INTO sys.alerts (alert_type, severity, params, dedupe_key)
                  VALUES (${a.type}, ${a.severity},
                          ${JSON.stringify({ which: a.which, ...a.params })}::jsonb,
                          ${`${a.type}:${a.which}:${day}`})
                  ON CONFLICT (dedupe_key) WHERE acknowledged_at IS NULL DO NOTHING`.execute(trx);
      }
    },
  );
  return alerts.length;
}
