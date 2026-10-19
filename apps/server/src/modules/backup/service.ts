/**
 * Settings → System health (decision 0086, M6.1): the state of the backups, the restore test, the
 * integrity checks and the disk; the owner's requests to the backup service; the backup key; the
 * Google Drive connection. Owner only (the permissions are owner-only in the database).
 */
import { randomUUID } from 'node:crypto';
import { stat, statfs, unlink } from 'node:fs/promises';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { sql, type Transaction } from 'kysely';
import {
  finishDeviceSignIn,
  GoogleError,
  saveDriveCredentials,
  startDeviceSignIn,
} from '@artepool/backup';
import type {
  BackupKeyResponse,
  BackupRequestBody,
  BackupRunInfo,
  ConfirmBackupKeyBody,
  DriveConnectBody,
  DriveConnectResponse,
  DriveFinishResponse,
  HealthProblem,
  HealthResponse,
  IntegrityCheckInfo,
} from '@artepool/shared/contracts';
import { recordEvent } from '../../platform/audit/events';
import type { Db } from '../../platform/db/pool';
import type { DB } from '../../platform/db/schema.generated';
import { withBusinessTx } from '../../platform/db/tx';
import { AppError } from '../../platform/errors/app-error';
import type { AppDeps } from '../../platform/http/deps';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const LOW_DISK_BYTES = 2 * 1024 ** 3;

type RunKind = 'logical_dump' | 'offsite_upload' | 'offline_copy' | 'restore_test';

async function runs(
  db: Db,
  kind: RunKind,
  status: 'success' | 'failed',
): Promise<BackupRunInfo | null> {
  const r = await db
    .selectFrom('ops.backup_runs')
    .select([
      'id',
      'status',
      'started_at',
      'finished_at',
      'file_name',
      'size_bytes',
      'error_message',
    ])
    .where('kind', '=', kind)
    .where('status', '=', status)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (!r) return null;
  return {
    id: r.id.toString(),
    status: r.status as BackupRunInfo['status'],
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    fileName: r.file_name,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    errorMessage: r.error_message,
  };
}

const age = (run: BackupRunInfo | null, now: number) =>
  run?.finishedAt ? now - Date.parse(run.finishedAt) : Number.POSITIVE_INFINITY;
const failedSince = (failure: BackupRunInfo | null, success: BackupRunInfo | null) =>
  failure !== null && (success === null || Number(failure.id) > Number(success.id));

async function recipient(db: Db): Promise<string | null> {
  const row = await db
    .selectFrom('sys.settings')
    .select('value')
    .where('key', '=', 'backup.age_recipient')
    .executeTakeFirst();
  return typeof row?.value === 'string' ? row.value : null;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

export async function healthStatus(deps: AppDeps, now = Date.now()): Promise<HealthResponse> {
  const { db } = deps;
  const [localOk, localFail, offOk, offFail, offline, restoreOk, restoreFail, key, driveConnected] =
    await Promise.all([
      runs(db, 'logical_dump', 'success'),
      runs(db, 'logical_dump', 'failed'),
      runs(db, 'offsite_upload', 'success'),
      runs(db, 'offsite_upload', 'failed'),
      runs(db, 'offline_copy', 'success'),
      runs(db, 'restore_test', 'success'),
      runs(db, 'restore_test', 'failed'),
      recipient(db),
      exists(deps.backup.driveCredentialsFile),
    ]);
  const [maxLocal, maxOffsite, restoreDays, offlineDays] = await Promise.all([
    deps.settings.number('backup.max_age_minutes.local'),
    deps.settings.number('backup.max_age_hours.offsite'),
    deps.settings.number('backup.restore_test_interval_days'),
    deps.settings.number('backup.offline_copy_interval_days'),
  ]);
  const integrity = await db
    .selectFrom('ops.integrity_runs')
    .select(['status', 'finished_at', 'results'])
    .orderBy('id', 'desc')
    .executeTakeFirst();
  const disk = await statfs(deps.backup.backupDir).then(
    (s) => ({ freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }),
    () => null,
  );
  const requests = await db
    .selectFrom('ops.backup_requests')
    .select(['id', 'kind', 'status', 'created_at', 'error_message'])
    .orderBy('id', 'desc')
    .limit(10)
    .execute();

  const problems: HealthProblem[] = [];
  if (age(localOk, now) > maxLocal * 60_000) problems.push('local_stale');
  if (failedSince(localFail, localOk)) problems.push('local_failed');
  const offsiteSetUp = key !== null && driveConnected;
  if (!offsiteSetUp) problems.push('offsite_not_set_up');
  else if (age(offOk, now) > maxOffsite * HOUR) problems.push('offsite_stale');
  if (failedSince(offFail, offOk)) problems.push('offsite_failed');
  if (age(offline, now) > offlineDays * DAY) problems.push('offline_due');
  if (age(restoreOk, now) > restoreDays * DAY) problems.push('restore_test_due');
  if (failedSince(restoreFail, restoreOk)) problems.push('restore_test_failed');
  if (integrity && (integrity.status === 'issues' || integrity.status === 'error'))
    problems.push('integrity_issues');
  if (disk && (disk.freeBytes < LOW_DISK_BYTES || disk.freeBytes < disk.totalBytes * 0.1))
    problems.push('disk_low');

  return {
    problems,
    local: {
      last: localOk,
      lastFailure: localFail,
      maxAgeMinutes: maxLocal,
      folder: deps.backup.backupDir,
    },
    offsite: {
      last: offOk,
      lastFailure: offFail,
      maxAgeHours: maxOffsite,
      keySet: key !== null,
      driveConnected,
    },
    offline: { last: offline, intervalDays: offlineDays },
    restoreTest: { last: restoreOk ?? restoreFail, intervalDays: restoreDays },
    integrity: {
      last: integrity
        ? {
            status: integrity.status as 'running' | 'ok' | 'issues' | 'error',
            finishedAt: integrity.finished_at?.toISOString() ?? null,
            checks: integrity.results as unknown as Record<string, IntegrityCheckInfo>,
          }
        : null,
    },
    disk,
    requests: requests.map((r) => ({
      id: r.id.toString(),
      kind: r.kind as HealthResponse['requests'][number]['kind'],
      status: r.status as HealthResponse['requests'][number]['status'],
      createdAt: r.created_at.toISOString(),
      errorMessage: r.error_message,
    })),
  };
}

// ------------------------------------------------------------------------------- requests

export async function createRequest(
  trx: Transaction<DB>,
  body: BackupRequestBody,
): Promise<{ id: string }> {
  const open = await trx
    .selectFrom('ops.backup_requests')
    .select('id')
    .where('kind', '=', body.kind)
    .where('status', 'in', ['pending', 'running'])
    .executeTakeFirst();
  if (open) throw new AppError('BACKUP_REQUEST_OPEN', 'This request is already waiting or running');
  const row = await trx
    .insertInto('ops.backup_requests')
    .values({ kind: body.kind, target: body.target ?? null } as never)
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id.toString() };
}

// ------------------------------------------------------------------------------- the key

/** A new key pair; the private part is returned once and never stored (decision 0086). */
export async function newBackupKey(): Promise<BackupKeyResponse> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

export async function confirmBackupKey(
  deps: AppDeps,
  trx: Transaction<DB>,
  body: ConfirmBackupKeyBody,
): Promise<{ ok: true }> {
  await trx
    .updateTable('sys.settings')
    .set({ value: sql`to_jsonb(${body.recipient}::text)` } as never)
    .where('key', '=', 'backup.age_recipient')
    .execute();
  deps.settings.invalidate();
  return { ok: true };
}

// ------------------------------------------------------------------------------- Google Drive

interface PendingSignIn {
  clientId: string;
  clientSecret: string;
  deviceCode: string;
  expiresAt: number;
}
/** Sign-ins waiting for the owner's approval at google.com/device, per user (memory only). */
const pending = new Map<string, PendingSignIn>();

const googleError = (error: unknown) =>
  error instanceof GoogleError
    ? new AppError('GOOGLE_FAILED', error.message, { google: error.code })
    : error;

export async function startDriveConnect(
  deps: AppDeps,
  userId: bigint,
  body: DriveConnectBody,
): Promise<DriveConnectResponse> {
  try {
    const code = await startDeviceSignIn(deps.backup.google, body.clientId);
    const expiresAt = Date.now() + code.expiresIn * 1000;
    pending.set(userId.toString(), { ...body, deviceCode: code.deviceCode, expiresAt });
    return {
      userCode: code.userCode,
      verificationUrl: code.verificationUrl,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: code.interval,
    };
  } catch (error) {
    throw googleError(error);
  }
}

export async function finishDriveConnect(
  deps: AppDeps,
  context: { userId: bigint; deviceId: bigint; sessionId: bigint },
): Promise<DriveFinishResponse> {
  const key = context.userId.toString();
  const sign = pending.get(key);
  if (!sign || sign.expiresAt < Date.now()) {
    pending.delete(key);
    throw new AppError('GOOGLE_FAILED', 'The Google sign-in expired: start again', {
      google: 'expired_token',
    });
  }
  let refreshToken: string | null;
  try {
    refreshToken = await finishDeviceSignIn(deps.backup.google, sign, sign.deviceCode);
  } catch (error) {
    pending.delete(key);
    throw googleError(error);
  }
  if (refreshToken === null) return { status: 'pending' };
  pending.delete(key);
  await saveDriveCredentials(deps.backup.driveCredentialsFile, deps.secretBox, {
    clientId: sign.clientId,
    clientSecret: sign.clientSecret,
    refreshToken,
    connectedAt: new Date().toISOString(),
  });
  await withBusinessTx(
    deps.db,
    {
      ...context,
      requestId: randomUUID(),
      reason: 'Google Drive connected for the off-site backups',
    },
    (trx) => recordEvent(trx, 'backup.drive_connected'),
  );
  return { status: 'connected' };
}

export async function disconnectDrive(deps: AppDeps, trx: Transaction<DB>): Promise<{ ok: true }> {
  await unlink(deps.backup.driveCredentialsFile).catch(() => undefined);
  await recordEvent(trx, 'backup.drive_disconnected');
  return { ok: true };
}

// ------------------------------------------------------------------------------- alerts

const ALERT_OF: Partial<Record<HealthProblem, { type: string; which: string }>> = {
  local_stale: { type: 'backup_stale', which: 'local' },
  local_failed: { type: 'backup_failed', which: 'local' },
  offsite_stale: { type: 'backup_stale', which: 'offsite' },
  offsite_failed: { type: 'backup_failed', which: 'offsite' },
  restore_test_failed: { type: 'backup_failed', which: 'restore_test' },
  restore_test_due: { type: 'restore_test_due', which: 'restore_test' },
  offline_due: { type: 'offline_copy_due', which: 'offline' },
  integrity_issues: { type: 'integrity_issue', which: 'integrity' },
};

/**
 * Raises one alert per problem per day (Dubai), checked every few minutes by the server; the
 * health screen shows the live state.
 */
export async function raiseBackupAlerts(deps: AppDeps, now = Date.now()): Promise<number> {
  const { problems } = await healthStatus(deps, now);
  const day = new Date(now + 4 * HOUR).toISOString().slice(0, 10);
  const alerts = problems.flatMap((p) => (ALERT_OF[p] ? [ALERT_OF[p]] : []));
  if (alerts.length === 0) return 0;
  await withBusinessTx(
    deps.db,
    { userId: 1n, requestId: randomUUID(), reason: 'backup health check' },
    async (trx) => {
      for (const a of alerts) {
        await sql`INSERT INTO sys.alerts (alert_type, severity, params, dedupe_key)
                VALUES (${a.type}, ${a.type === 'restore_test_due' || a.type === 'offline_copy_due' ? 'info' : 'warning'},
                        ${JSON.stringify({ which: a.which })}::jsonb, ${`${a.type}:${a.which}:${day}`})
                ON CONFLICT (dedupe_key) WHERE acknowledged_at IS NULL DO NOTHING`.execute(trx);
      }
    },
  );
  return alerts.length;
}
