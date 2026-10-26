/**
 * Automatic renewal of the server certificate (M6.2 part H3) on a real PostgreSQL, with the
 * service restart and the /health check faked: nothing before 60 days are left; only at night with
 * no open shift; a new certificate from the same CA for the same names, checked before it is used;
 * the old files kept and put back when the server does not answer with the new one; at most one
 * try a day; every renewal and failure audited with the old and new expiry dates.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectionFor } from '@artepool/node-kit';
import { createTestDatabase, inContext, type TestDatabase } from '@artepool/testing';
import {
  certificateExpiry,
  createCa,
  issueServerCert,
  serverCertNames,
  TLS_FILES,
  writeTlsFile,
  type PemPair,
} from '@artepool/tls';
import { renewServerCertificate, type RenewalDeps } from '../../src/cli/updater/certificate';

const NAMES = { dns: ['localhost', 'artepool-server'], ips: ['127.0.0.1'] };
const DAY = 24 * 3600 * 1000;

/** 03:00 in the shop (23:00 UTC), `days` from today: inside the default night window 02–05. */
function night(days = 0): Date {
  const at = new Date();
  at.setUTCHours(23, 0, 0, 0);
  return new Date(at.getTime() + days * DAY);
}
/** 15:00 in the shop. */
const afternoon = () => new Date(night().getTime() - 12 * 3600 * 1000);

let db: TestDatabase;
let client: pg.Client;
let su: pg.Client;
let tlsDir: string;
let ca: PemPair;
let restarts = 0;

const file = (name: string) => join(tlsDir, name);
const onDisk = () => readFile(file(TLS_FILES.serverCert), 'utf8');

async function serverCertificate(days: number): Promise<string> {
  const pair = await issueServerCert(ca, NAMES, days);
  await writeTlsFile(tlsDir, TLS_FILES.serverCert, pair.certPem);
  await writeTlsFile(tlsDir, TLS_FILES.serverKey, pair.keyPem);
  return pair.certPem;
}

function deps(patch: Partial<RenewalDeps> = {}): RenewalDeps {
  return {
    db: client,
    tlsDir,
    now: () => night(),
    restartServer: () => {
      restarts++;
      return Promise.resolve();
    },
    // The faked server "answers" with whatever certificate is on disk.
    waitHealthy: async (_ca, served) => {
      if ((await onDisk()) !== served) throw new Error('the server answered with another one');
    },
    log: () => undefined,
    ...patch,
  };
}

const row = async () =>
  (await su.query('SELECT * FROM ops.server_health WHERE id = 1')).rows[0] as Record<
    string,
    unknown
  >;

beforeAll(async () => {
  db = await createTestDatabase();
  su = await db.connect('superuser');
  client = new pg.Client(connectionFor('backup', db.name));
  await client.connect();
  tlsDir = await mkdtemp(join(tmpdir(), 'artepool-renewal-'));
  ca = await createCa(NAMES);
  await writeTlsFile(tlsDir, TLS_FILES.caCert, ca.certPem);
  await writeTlsFile(tlsDir, TLS_FILES.caKey, ca.keyPem);
}, 120_000);
afterAll(async () => {
  await client.end();
  await su.end();
  await db.drop();
  await rm(tlsDir, { recursive: true, force: true });
});
beforeEach(async () => {
  restarts = 0;
  await inContext(su, () =>
    su.query(
      `UPDATE ops.server_health SET cert_expires_at = NULL, cert_renewed_at = NULL,
              cert_renew_attempted_at = NULL, cert_renew_error = NULL WHERE id = 1`,
    ),
  );
});

describe('the server certificate renewal', () => {
  it('records the expiry and does nothing before 60 days are left', async () => {
    const pem = await serverCertificate(400);
    expect(await renewServerCertificate(deps())).toBe('not_due');
    expect((await row()).cert_expires_at).toEqual(certificateExpiry(pem));
    expect(await onDisk()).toBe(pem);
  });

  it('waits for the night window and for every shift to be closed', async () => {
    await serverCertificate(30);
    expect(await renewServerCertificate(deps({ now: afternoon }))).toBe('waiting');
    await su.query('SET session_replication_role = replica');
    await inContext(su, () =>
      su.query(
        `INSERT INTO cash.shifts (series_id, seq_no, shift_number, register_id, cashier_id,
                                  opened_by, opening_float_fils, created_by, updated_by)
         VALUES (1, 1, 'SH-CERT', 1, 1, 1, 0, 1, 1)`,
      ),
    );
    await su.query('SET session_replication_role = DEFAULT');
    try {
      expect(await renewServerCertificate(deps())).toBe('waiting');
    } finally {
      await su.query('SET session_replication_role = replica');
      await su.query(`DELETE FROM cash.shifts WHERE shift_number = 'SH-CERT'`);
      await su.query('SET session_replication_role = DEFAULT');
    }
    expect(restarts).toBe(0);
  });

  it('renews from the same CA for the same names, keeps the old files, audits the dates', async () => {
    const old = await serverCertificate(30);
    const oldKey = await readFile(file(TLS_FILES.serverKey), 'utf8');
    expect(await renewServerCertificate(deps())).toBe('renewed');
    const fresh = await onDisk();
    expect(fresh).not.toBe(old);
    expect(serverCertNames(fresh)).toEqual(NAMES);
    const days = (certificateExpiry(fresh).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(729);
    expect(await readFile(file(`${TLS_FILES.serverCert}.previous`), 'utf8')).toBe(old);
    expect(await readFile(file(`${TLS_FILES.serverKey}.previous`), 'utf8')).toBe(oldKey);
    expect(restarts).toBe(1);
    const r = await row();
    expect(r.cert_renew_error).toBeNull();
    expect(r.cert_renewed_at).not.toBeNull();
    const { rows } = await su.query<{ old: string; new: string; reason: string }>(
      `SELECT old_values ->> 'cert_expires_at' AS old, new_values ->> 'cert_expires_at' AS new,
              reason
         FROM audit.log WHERE entity_type = 'ops.server_health' AND action = 'update'
        ORDER BY id DESC LIMIT 1`,
    );
    expect(new Date(rows[0]!.old)).toEqual(certificateExpiry(old));
    expect(new Date(rows[0]!.new)).toEqual(certificateExpiry(fresh));
    expect(rows[0]!.reason).toMatch(/renewed until/);
    expect(JSON.stringify(rows)).not.toMatch(/PRIVATE KEY/);
    // Renewed: no longer due.
    expect(await renewServerCertificate(deps({ now: () => night(1) }))).toBe('not_due');
  });

  it('never switches when the new certificate fails its check', async () => {
    const old = await serverCertificate(30);
    const outcome = await renewServerCertificate(
      deps({ checkPair: () => Promise.reject(new Error('handshake refused')) }),
    );
    expect(outcome).toBe('failed');
    expect(await onDisk()).toBe(old);
    expect(restarts).toBe(0);
    expect((await row()).cert_renew_error).toBe('the new certificate: handshake refused');
  });

  it('puts the old certificate back when the server does not answer with the new one', async () => {
    const old = await serverCertificate(30);
    const oldKey = await readFile(file(TLS_FILES.serverKey), 'utf8');
    const outcome = await renewServerCertificate(
      deps({ waitHealthy: () => Promise.reject(new Error('no answer')) }),
    );
    expect(outcome).toBe('failed');
    expect(await onDisk()).toBe(old);
    expect(await readFile(file(TLS_FILES.serverKey), 'utf8')).toBe(oldKey);
    expect(restarts).toBe(2); // with the new one, then again with the old one
    expect((await row()).cert_renew_error).toBe('the server with the new certificate: no answer');
  });

  it('tries at most once a day after a failure, and again the next night', async () => {
    await serverCertificate(30);
    const failing = { checkPair: () => Promise.reject(new Error('handshake refused')) };
    expect(await renewServerCertificate(deps(failing))).toBe('failed');
    expect(await renewServerCertificate(deps(failing))).toBe('tried_today');
    expect(await renewServerCertificate(deps({ now: () => night(1) }))).toBe('renewed');
    expect((await row()).cert_renew_error).toBeNull();
  });

  it('does nothing without a certificate', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'artepool-renewal-empty-'));
    try {
      expect(await renewServerCertificate(deps({ tlsDir: empty }))).toBe('no_certificate');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
