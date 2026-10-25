/**
 * Settings → System health (decision 0086, M6.1) through the API: owner only; the live problems;
 * the owner's requests (one open per kind); the backup key (private part never kept); the Google
 * Drive connection by device sign-in (token sealed on disk, never in the database); one alert per
 * problem per day.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BackupKeyResponse,
  DriveConnectResponse,
  HealthResponse,
} from '@artepool/shared/contracts';
import { authorizeDrive, raiseBackupAlerts } from '../../src/modules/backup/service';
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
import { startFakeGoogle, type FakeGoogle } from '../../../backup/test/support/fake-google';

let server: TestServer;
let google: FakeGoogle;
let dir: string;
let office: TestDevice;
let ownerToken: string;
let accountantToken: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artepool-health-'));
  google = await startFakeGoogle();
  server = await startTestServer(undefined, {
    backup: {
      backupDir: dir,
      masterKey: { file: join(dir, 'unused.key') },
      driveCredentialsFile: join(dir, 'secrets', 'google-drive.sealed'),
      google: google.endpoints,
      googleClients: {
        desktop: {
          clientId: 'desktop-1.apps.googleusercontent.com',
          clientSecret: 'GOCSPX-desktop',
        },
        device: { clientId: 'client-1', clientSecret: 'secret-1' },
      },
    },
  });
  office = await addDevice(server, { code: 'OFFICE-01', kind: 'office' });
  const owner = await addOwnerWithTwoStep(server, { username: 'owner.main' });
  ownerToken = (
    await openSession(server, { userId: owner.id, deviceId: office.id, method: 'password_totp' })
  ).token;
  const accountant = await addUser(server, { username: 'khaled.acc', roles: ['accountant'] });
  accountantToken = (await openSession(server, { userId: accountant, deviceId: office.id })).token;
});
afterAll(async () => {
  await server.close();
  await google.close();
  await rm(dir, { recursive: true, force: true });
});

const get = (token = ownerToken) =>
  call(server, 'GET', '/api/v1/health/system', { device: office, token });
const post = (url: string, body: unknown = {}, token = ownerToken) =>
  call(server, 'POST', url, { device: office, token, body, idempotencyKey: randomUUID() });

describe('system health', () => {
  it('is for the owner only', async () => {
    expect(errorCode(await get(accountantToken))).toBe('PERMISSION_DENIED');
    expect(
      errorCode(await post('/api/v1/backup/requests', { kind: 'backup_now' }, accountantToken)),
    ).toBe('PERMISSION_DENIED');
    expect(errorCode(await post('/api/v1/backup/key', {}, accountantToken))).toBe(
      'PERMISSION_DENIED',
    );
  });

  it('shows what needs attention on a new system', async () => {
    const health = (await get()).json<HealthResponse>();
    expect(health.problems).toEqual(
      expect.arrayContaining([
        'local_stale',
        'offsite_not_set_up',
        'offline_due',
        'restore_test_due',
      ]),
    );
    expect(health.local).toMatchObject({ last: null, maxAgeMinutes: 90, folder: dir });
    expect(health.offsite).toMatchObject({ keySet: false, driveConnected: false, maxAgeHours: 30 });
    expect(health.disk?.totalBytes).toBeGreaterThan(0);
  });

  it('takes the owner’s requests, one open per kind', async () => {
    const first = await post('/api/v1/backup/requests', { kind: 'backup_now' });
    expect(first.statusCode).toBe(201);
    expect(errorCode(await post('/api/v1/backup/requests', { kind: 'backup_now' }))).toBe(
      'BACKUP_REQUEST_OPEN',
    );
    expect(errorCode(await post('/api/v1/backup/requests', { kind: 'offline_copy' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      (await post('/api/v1/backup/requests', { kind: 'offline_copy', target: 'E:\\' })).statusCode,
    ).toBe(201);
    const health = (await get()).json<HealthResponse>();
    expect(health.requests.map((r) => [r.kind, r.status])).toEqual([
      ['offline_copy', 'pending'],
      ['backup_now', 'pending'],
    ]);
  });

  it('creates the backup key: the private key is shown once, only the public key is kept', async () => {
    const key = (await post('/api/v1/backup/key')).json<BackupKeyResponse>();
    expect(key.identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    expect(key.recipient).toMatch(/^age1[0-9a-z]{58}$/);
    expect(
      (await post('/api/v1/backup/key/confirm', { recipient: key.recipient })).statusCode,
    ).toBe(200);
    expect((await get()).json<HealthResponse>().offsite.keySet).toBe(true);
    // The private key is nowhere in the database or the server log.
    const { rows } = await server.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.log WHERE new_values::text LIKE '%AGE-SECRET-KEY%'`,
    );
    expect(rows[0]!.n).toBe(0);
    expect(server.logs.join('\n')).not.toContain(key.identity);
    expect(errorCode(await post('/api/v1/backup/key/confirm', { recipient: key.identity }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('connects Google Drive by choosing the account; the token is sealed on disk', async () => {
    expect((await get()).json<HealthResponse>().offsite.google).toEqual({
      chooseAccount: true,
      code: true,
    });
    // Only an address on the same PC may receive Google's code.
    expect(
      errorCode(
        await post('/api/v1/backup/drive/authorize', {
          redirectUri: 'https://evil.example/callback',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    const redirectUri = 'http://127.0.0.1:53682/callback';
    const first = (await post('/api/v1/backup/drive/authorize', { redirectUri })).json<{
      authUrl: string;
    }>();
    const url = new URL(first.authUrl);
    expect(url.searchParams.get('client_id')).toBe('desktop-1.apps.googleusercontent.com');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('prompt')).toContain('select_account');
    // A code with another sign-in's state is refused (and that sign-in must start again).
    const stolen = google.chooseAccount(first.authUrl);
    expect(
      errorCode(
        await post('/api/v1/backup/drive/callback', { code: stolen.code, state: 'x'.repeat(32) }),
      ),
    ).toBe('GOOGLE_FAILED');
    const again = (await post('/api/v1/backup/drive/authorize', { redirectUri })).json<{
      authUrl: string;
    }>();
    const chosen = google.chooseAccount(again.authUrl);
    expect(
      (
        await post('/api/v1/backup/drive/callback', { code: chosen.code, state: chosen.state })
      ).json(),
    ).toEqual({ status: 'connected' });
    const sealed = await readFile(join(dir, 'secrets', 'google-drive.sealed'), 'utf8');
    expect(sealed).not.toContain('refresh-xyz');
    expect(sealed).not.toContain('GOCSPX');
    const health = (await get()).json<HealthResponse>();
    expect(health.offsite.driveConnected).toBe(true);
    expect(health.problems).not.toContain('offsite_not_set_up');
    const { rows } = await server.admin.query<{ data: { how: string } }>(
      `SELECT new_values AS data FROM audit.log WHERE action = 'event:backup.drive_connected'`,
    );
    expect(rows.map((r) => r.data.how)).toEqual(['account']);
    expect((await post('/api/v1/backup/drive/disconnect')).statusCode).toBe(200);
    await expect(stat(join(dir, 'secrets', 'google-drive.sealed'))).rejects.toThrow();
  });

  it('still connects with a code typed at google.com/device, without typing any ID', async () => {
    const start = await post('/api/v1/backup/drive/connect');
    expect(start.json<DriveConnectResponse>()).toMatchObject({ userCode: 'ABCD-EFGH' });
    expect((await post('/api/v1/backup/drive/finish')).json()).toEqual({ status: 'pending' });
    google.approve();
    expect((await post('/api/v1/backup/drive/finish')).json()).toEqual({ status: 'connected' });
    await post('/api/v1/backup/drive/disconnect');
  });

  it('says so when the installation has no Google registration', () => {
    const bare = {
      ...server.deps,
      backup: { ...server.deps.backup, googleClients: { desktop: null, device: null } },
    };
    expect(() =>
      authorizeDrive(bare, 1n, { redirectUri: 'http://127.0.0.1:53682/callback' }),
    ).toThrow(expect.objectContaining({ code: 'GOOGLE_NOT_CONFIGURED' }) as Error);
  });

  it('raises one alert per problem per day', async () => {
    expect(await raiseBackupAlerts(server.deps)).toBeGreaterThan(0);
    await raiseBackupAlerts(server.deps);
    const { rows } = await server.admin.query<{ alert_type: string; n: number }>(
      `SELECT alert_type, count(*)::int AS n FROM sys.alerts GROUP BY 1 ORDER BY 1`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { alert_type: 'backup_stale', n: 1 },
        { alert_type: 'offline_copy_due', n: 1 },
        { alert_type: 'restore_test_due', n: 1 },
      ]),
    );
  });
});
