import { z } from 'zod';

/**
 * Settings → System health (decision 0086, M6.1): backups, the restore test, the integrity
 * checks and the disk. Owner only.
 */
export interface BackupRunInfo {
  id: string;
  status: 'running' | 'success' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  errorMessage: string | null;
}

export type HealthProblem =
  | 'local_stale'
  | 'local_failed'
  | 'offsite_not_set_up'
  | 'offsite_stale'
  | 'offsite_failed'
  | 'offline_due'
  | 'restore_test_due'
  | 'restore_test_failed'
  | 'integrity_issues'
  | 'disk_low';

export const BACKUP_REQUEST_KINDS = [
  'backup_now',
  'offsite_now',
  'restore_test',
  'offline_copy',
] as const;
export type BackupRequestKind = (typeof BACKUP_REQUEST_KINDS)[number];

export interface BackupRequestInfo {
  id: string;
  kind: BackupRequestKind;
  status: 'pending' | 'running' | 'done' | 'failed';
  createdAt: string;
  errorMessage: string | null;
}

export interface IntegrityCheckInfo {
  ok: boolean;
  problems: number;
  examples: string[];
}

export interface HealthResponse {
  /** What needs the owner's attention now (shown on top and on the dashboard). */
  problems: HealthProblem[];
  local: {
    last: BackupRunInfo | null;
    lastFailure: BackupRunInfo | null;
    maxAgeMinutes: number;
    folder: string;
  };
  offsite: {
    last: BackupRunInfo | null;
    lastFailure: BackupRunInfo | null;
    maxAgeHours: number;
    keySet: boolean;
    driveConnected: boolean;
    /** Whether this installation carries the app's Google registration (decision 0095). */
    google: { chooseAccount: boolean; code: boolean };
  };
  offline: { last: BackupRunInfo | null; intervalDays: number };
  restoreTest: { last: BackupRunInfo | null; intervalDays: number };
  integrity: {
    last: {
      status: 'running' | 'ok' | 'issues' | 'error';
      finishedAt: string | null;
      checks: Record<string, IntegrityCheckInfo>;
    } | null;
  };
  disk: { freeBytes: number; totalBytes: number } | null;
  requests: BackupRequestInfo[];
}

export const BackupRequestBody = z
  .object({
    kind: z.enum(BACKUP_REQUEST_KINDS),
    /** The external drive's folder (offline_copy only), for example E:\ */
    target: z.string().trim().min(2).max(260).optional(),
  })
  .strict()
  .refine((b) => (b.kind === 'offline_copy') === (b.target !== undefined), { path: ['target'] });
export type BackupRequestBody = z.infer<typeof BackupRequestBody>;

/** A new backup key: the private key is shown once and never kept by the server. */
export interface BackupKeyResponse {
  identity: string;
  recipient: string;
}

export const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

export const ConfirmBackupKeyBody = z
  .object({ recipient: z.string().regex(AGE_RECIPIENT) })
  .strict();
export type ConfirmBackupKeyBody = z.infer<typeof ConfirmBackupKeyBody>;

/**
 * Connecting the shop's Google account (decision 0095): the app opens Google's page in the
 * browser; Google sends the one-time code back to a short-lived address on that same PC.
 */
export const DriveAuthorizeBody = z
  .object({ redirectUri: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{2,5}\/callback$/) })
  .strict();
export type DriveAuthorizeBody = z.infer<typeof DriveAuthorizeBody>;

export interface DriveAuthorizeResponse {
  authUrl: string;
}

export const DriveCallbackBody = z
  .object({
    code: z.string().min(4).max(1000),
    state: z.string().min(16).max(200),
  })
  .strict();
export type DriveCallbackBody = z.infer<typeof DriveCallbackBody>;

/** The fallback: a short code typed at google.com/device (decision 0086). */
export interface DriveConnectResponse {
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface DriveFinishResponse {
  status: 'pending' | 'connected';
}
