/**
 * The server PC's health in System health (M6.2 part H): disks, services, WAL archiving, the
 * server certificate and the root CA, the clock and the UPS; the database's power-cut settings
 * and the integrity check after its last start (part I). Owner only.
 */

/** ok: nothing to do; warning: look at it soon (orange); urgent: act now (red). */
export type HealthLevel = 'ok' | 'warning' | 'urgent';

export const SERVER_DISKS = ['data', 'backups', 'system'] as const;
export type ServerDisk = (typeof SERVER_DISKS)[number];

export type ServerHealthProblem =
  | 'disk_low'
  | 'disk_urgent'
  | 'backup_service_down'
  | 'wal_archive_failed'
  | 'certificate_expiring'
  | 'certificate_renewal_failed'
  | 'root_ca_expiring'
  | 'clock_behind'
  | 'ups_unconfirmed'
  | 'durability_off'
  | 'start_check_failed';

export interface DiskInfo {
  disk: ServerDisk;
  path: string;
  freeBytes: number;
  totalBytes: number;
  level: HealthLevel;
}

export interface CertificateInfo {
  expiresAt: string;
  daysLeft: number;
  level: HealthLevel;
}

export interface ServerHealth {
  problems: ServerHealthProblem[];
  /** One entry per disk that could be read (the same disk may appear under two names). */
  disks: DiskInfo[];
  services: {
    /** The backup service's last sign of life (it writes one every minute). */
    backupHeartbeatAt: string | null;
    backupRunning: boolean;
  };
  wal: {
    /** WAL archiving is set up on the installed server PC (off on a development PC). */
    enabled: boolean;
    lastArchivedAt: string | null;
    lastFailedAt: string | null;
    failing: boolean;
  };
  certificate: {
    server: CertificateInfo | null;
    rootCa: CertificateInfo | null;
    lastRenewedAt: string | null;
    lastAttemptAt: string | null;
    /** The last automatic renewal failed; it is tried again the next night. */
    renewalError: string | null;
  };
  clock: { serverTime: string; latestRecordAt: string | null; isBehind: boolean };
  ups: { confirmedAt: string | null; due: boolean; reminderDays: number };
  database: {
    /** When the database last started (after a power cut, a restart or an update). */
    startedAt: string;
    /** The settings that keep a confirmed sale through a power cut; `off` lists any that are not. */
    durability: { ok: boolean; off: string[] };
    /** The integrity checks run once after that start; null while they have not run yet. */
    startCheck: { status: 'running' | 'ok' | 'issues' | 'error'; finishedAt: string | null } | null;
  };
  /** The cashier's Windows account (M6.4), as the server PC's own programs last checked it. */
  cashierAccount: CashierAccountHealth;
}

/** What `artepool-svc cashier-account check` names as missing (M6.4). */
export const CASHIER_ACCOUNT_ITEMS = [
  'account',
  'enabled',
  'standard',
  'password_expiry',
  'auto_sign_in',
  'password_stored',
  'plain_password',
  'enrollment',
  'folders',
  'services',
  'active_hours',
] as const;
export type CashierAccountItem = (typeof CASHIER_ACCOUNT_ITEMS)[number];
export const CASHIER_ACCOUNT_STATES = ['ok', 'repair', 'not_set_up'] as const;
export type CashierAccountState = (typeof CASHIER_ACCOUNT_STATES)[number];

export interface CashierAccountHealth {
  /** null: never checked (a development PC, or the updater has not run yet). */
  state: CashierAccountState | null;
  missing: CashierAccountItem[];
  checkedAt: string | null;
  /** The owner's last "Set up / repair" in the emergency tool. */
  setupAt: string | null;
}
