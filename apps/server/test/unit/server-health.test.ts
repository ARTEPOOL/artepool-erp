/**
 * The server PC's health rules (M6.2 part H): disk levels (warning under 10% or 10 GB, urgent
 * under 5% or 2 GB), certificate levels (server: 60 and 14 days; root CA: two years and six
 * months), the UPS reminder after six months, the backup service heartbeat, and which problems
 * become owner alerts.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEARTBEAT_FILE, readHeartbeat, writeHeartbeat } from '@artepool/backup';
import type { ServerHealth } from '@artepool/shared/contracts';
import {
  CERT_LEVELS,
  certificateLevel,
  diskLevel,
  healthAlerts,
  ROOT_CA_LEVELS,
  upsDue,
} from '../../src/modules/health/service';

const GB = 1024 ** 3;
const DAY = 24 * 3600 * 1000;

describe('disk levels', () => {
  it('warns under 10% or 10 GB free and is urgent under 5% or 2 GB', () => {
    expect(diskLevel(200 * GB, 500 * GB)).toBe('ok');
    expect(diskLevel(9 * GB, 100 * GB)).toBe('warning'); // under 10 GB (9%)
    expect(diskLevel(40 * GB, 500 * GB)).toBe('warning'); // under 10%
    expect(diskLevel(1.5 * GB, 500 * GB)).toBe('urgent'); // under 2 GB
    expect(diskLevel(20 * GB, 500 * GB)).toBe('urgent'); // under 5%
    expect(diskLevel(15 * GB, 100 * GB)).toBe('ok'); // 15%, 15 GB
  });
});

describe('certificate levels', () => {
  it('server certificate: orange from 60 days, red from 14', () => {
    expect(certificateLevel(61, CERT_LEVELS)).toBe('ok');
    expect(certificateLevel(60, CERT_LEVELS)).toBe('warning');
    expect(certificateLevel(15, CERT_LEVELS)).toBe('warning');
    expect(certificateLevel(14, CERT_LEVELS)).toBe('urgent');
    expect(certificateLevel(-3, CERT_LEVELS)).toBe('urgent');
  });

  it('root CA: orange from two years, red from six months', () => {
    expect(certificateLevel(731, ROOT_CA_LEVELS)).toBe('ok');
    expect(certificateLevel(730, ROOT_CA_LEVELS)).toBe('warning');
    expect(certificateLevel(180, ROOT_CA_LEVELS)).toBe('urgent');
  });
});

describe('the UPS reminder', () => {
  it('is due when never confirmed or confirmed more than six months ago', () => {
    const now = Date.parse('2026-10-26T08:00:00Z');
    expect(upsDue(null, now)).toBe(true);
    expect(upsDue(new Date(now - 30 * DAY), now)).toBe(false);
    expect(upsDue(new Date(now - 183 * DAY), now)).toBe(true);
  });
});

describe('the backup service heartbeat', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artepool-heartbeat-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('is read back, and missing or damaged reads as none', async () => {
    expect(await readHeartbeat(dir)).toBeNull();
    const at = new Date('2026-10-26T08:00:00.000Z');
    await writeHeartbeat(dir, at);
    expect(await readHeartbeat(dir)).toEqual(at);
    await writeFile(join(dir, HEARTBEAT_FILE), 'not a time');
    expect(await readHeartbeat(dir)).toBeNull();
  });
});

const healthy: ServerHealth = {
  problems: [],
  disks: [{ disk: 'data', path: 'C:\\', freeBytes: 200 * GB, totalBytes: 500 * GB, level: 'ok' }],
  services: { backupHeartbeatAt: '2026-10-26T08:00:00.000Z', backupRunning: true },
  wal: { enabled: true, lastArchivedAt: null, lastFailedAt: null, failing: false },
  certificate: {
    server: { expiresAt: '2028-10-26T00:00:00.000Z', daysLeft: 730, level: 'ok' },
    rootCa: { expiresAt: '2046-10-26T00:00:00.000Z', daysLeft: 7300, level: 'ok' },
    lastRenewedAt: null,
    lastAttemptAt: null,
    renewalError: null,
  },
  clock: { serverTime: '2026-10-26T08:00:00.000Z', latestRecordAt: null, isBehind: false },
  ups: { confirmedAt: '2026-10-01T08:00:00.000Z', due: false, reminderDays: 182 },
};

describe('owner alerts', () => {
  it('none when everything is fine', () => {
    expect(healthAlerts(healthy)).toEqual([]);
  });

  it('one per problem, with its severity', () => {
    const alerts = healthAlerts({
      ...healthy,
      disks: [
        { ...healthy.disks[0]!, level: 'urgent' },
        {
          disk: 'backups',
          path: 'D:\\',
          freeBytes: 9 * GB,
          totalBytes: 500 * GB,
          level: 'warning',
        },
      ],
      services: { backupHeartbeatAt: null, backupRunning: false },
      wal: { ...healthy.wal, failing: true },
      certificate: {
        ...healthy.certificate,
        server: { expiresAt: '2026-11-01T00:00:00.000Z', daysLeft: 6, level: 'urgent' },
        rootCa: { expiresAt: '2028-01-01T00:00:00.000Z', daysLeft: 430, level: 'warning' },
        renewalError: 'the check failed',
      },
      ups: { confirmedAt: null, due: true, reminderDays: 182 },
    });
    expect(alerts.map((a) => [a.type, a.severity, a.which])).toEqual([
      ['disk_urgent', 'critical', 'data'],
      ['disk_low', 'warning', 'backups'],
      ['service_down', 'critical', 'backup'],
      ['wal_archive_failed', 'warning', 'wal'],
      ['certificate_expiring', 'critical', 'server'],
      ['certificate_renewal_failed', 'warning', 'server'],
      ['root_ca_expiring', 'warning', 'root_ca'],
      ['ups_unconfirmed', 'info', 'ups'],
    ]);
  });
});
