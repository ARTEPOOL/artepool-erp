/**
 * The server PC's health in System health (M6.2 part H): disks, services, WAL archiving, the
 * server certificate and the root CA, the clock and the UPS. Owner only.
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
  | 'ups_unconfirmed';

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
}
