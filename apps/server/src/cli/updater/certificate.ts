/**
 * Automatic renewal of the server certificate (M6.2 part H3), run by the server PC's updater (the
 * SYSTEM scheduled task) every few minutes:
 *
 *   1. it records the certificate's expiry date in ops.server_health (shown on System health);
 *   2. 60 days before the end, at a safe time (the night window, no open shift) and at most once a
 *      day, it issues a new certificate from the same root CA for the same names, so every PC
 *      keeps trusting it and nothing is asked of anyone;
 *   3. it proves the new certificate and key work (a local TLS 1.3 check) before using them;
 *   4. it keeps the old files as *.previous, switches, restarts the server and checks /health;
 *      any failure puts the old files back and restarts the server again;
 *   5. every renewal and every failed try is in the audit log (ops.server_health: the old and new
 *      expiry dates, the error; never a key).
 */
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import { inSystemTx } from '@artepool/backup';
import {
  certificateExpiry,
  checkServerPair,
  issueServerCert,
  serverCertNames,
  TLS_FILES,
  type PemPair,
} from '@artepool/tls';
import { inWindow } from './steps';

/** Renewed this many days before the end (System health turns orange from here). */
export const RENEW_DAYS_BEFORE = 60;
/** A new server certificate is valid for two years, like the first one. */
export const SERVER_CERT_DAYS = 730;

const DAY = 24 * 3600 * 1000;

export type RenewalOutcome =
  'no_certificate' | 'not_due' | 'tried_today' | 'waiting' | 'renewed' | 'failed';

export interface RenewalDeps {
  /** As the backup role (it records the certificate state and reads the shifts). */
  db: pg.Client;
  tlsDir: string;
  now: () => Date;
  /** Stops and starts the server service so it loads the certificate files again. */
  restartServer: () => Promise<void>;
  /** The server answers /health over TLS 1.3, trusting only the CA, with this certificate. */
  waitHealthy: (caCertPem: string, servedCertPem: string) => Promise<void>;
  /** The local check of a new pair; replaceable in tests. */
  checkPair?: (pair: PemPair, caCertPem: string) => Promise<void>;
  log: (line: string) => void;
}

const dubaiDay = (at: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(at);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function renewServerCertificate(deps: RenewalDeps): Promise<RenewalOutcome> {
  const { db, log } = deps;
  const now = deps.now();
  const file = (name: string) => join(deps.tlsDir, name);
  const record = (values: Record<string, unknown>, reason: string) =>
    inSystemTx(db, `certificate: ${reason}`, async () => {
      const keys = Object.keys(values);
      await db.query(
        `UPDATE ops.server_health SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
          WHERE id = 1`,
        keys.map((k) => values[k]),
      );
    });

  let currentPem: string;
  try {
    currentPem = await readFile(file(TLS_FILES.serverCert), 'utf8');
  } catch {
    return 'no_certificate';
  }
  const expires = certificateExpiry(currentPem);
  const { rows } = await db.query<{
    cert_expires_at: Date | null;
    cert_renew_attempted_at: Date | null;
  }>('SELECT cert_expires_at, cert_renew_attempted_at FROM ops.server_health WHERE id = 1');
  const row = rows[0]!;
  if (row.cert_expires_at?.getTime() !== expires.getTime()) {
    await record({ cert_expires_at: expires }, 'the server certificate in use');
  }

  // 2. Due, not tried yet today, and a safe time.
  if (expires.getTime() - now.getTime() > RENEW_DAYS_BEFORE * DAY) return 'not_due';
  if (row.cert_renew_attempted_at && dubaiDay(row.cert_renew_attempted_at) === dubaiDay(now)) {
    return 'tried_today';
  }
  const window = (
    await db.query<{ start: number; end: number }>(
      'SELECT window_start_hour AS start, window_end_hour AS "end" FROM ops.update_state WHERE id = 1',
    )
  ).rows[0]!;
  const open = (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cash.shifts WHERE status = 'open'`,
    )
  ).rows[0]!.n;
  if (open > 0 || !inWindow(now, window.start, window.end)) return 'waiting';

  const fail = async (error: unknown, step: string) => {
    const text = `${step}: ${message(error)}`.slice(0, 500);
    log(`The server certificate was not renewed (${text}); it is tried again tomorrow night.`);
    await record(
      { cert_renew_attempted_at: now, cert_renew_error: text },
      'the renewal failed; tried again tomorrow',
    );
    return 'failed' as const;
  };

  // 3. A new certificate from the same CA for the same names, checked before it is used.
  let caCertPem: string;
  let fresh: PemPair;
  try {
    caCertPem = await readFile(file(TLS_FILES.caCert), 'utf8');
    const caKeyPem = await readFile(file(TLS_FILES.caKey), 'utf8');
    fresh = await issueServerCert(
      { certPem: caCertPem, keyPem: caKeyPem },
      serverCertNames(currentPem),
      SERVER_CERT_DAYS,
    );
    await (deps.checkPair ?? checkServerPair)(fresh, caCertPem);
  } catch (error) {
    return fail(error, 'the new certificate');
  }

  // 4. The old files kept; the new ones in place; the server restarted and checked.
  const certFile = file(TLS_FILES.serverCert);
  const keyFile = file(TLS_FILES.serverKey);
  const previous = (name: string) => `${name}.previous`;
  const putBack = async () => {
    await copyFile(previous(certFile), certFile);
    await copyFile(previous(keyFile), keyFile);
  };
  try {
    await copyFile(certFile, previous(certFile));
    await copyFile(keyFile, previous(keyFile));
    // Each written beside first, then renamed, so a file is never half written.
    await writeFile(`${keyFile}.new`, fresh.keyPem);
    await writeFile(`${certFile}.new`, fresh.certPem);
    await rename(`${keyFile}.new`, keyFile);
    await rename(`${certFile}.new`, certFile);
  } catch (error) {
    await rm(`${keyFile}.new`, { force: true });
    await rm(`${certFile}.new`, { force: true });
    await putBack().catch(() => undefined);
    return fail(error, 'switching the files');
  }
  try {
    await deps.restartServer();
    await deps.waitHealthy(caCertPem, fresh.certPem);
  } catch (error) {
    log('The server did not answer with the new certificate: the previous one is put back.');
    try {
      await putBack();
      await deps.restartServer();
    } catch (back) {
      log(`Putting the previous certificate back failed: ${message(back)}`);
    }
    return fail(error, 'the server with the new certificate');
  }

  const renewedUntil = certificateExpiry(fresh.certPem);
  await record(
    {
      cert_expires_at: renewedUntil,
      cert_renewed_at: now,
      cert_renew_attempted_at: now,
      cert_renew_error: null,
    },
    `renewed until ${renewedUntil.toISOString().slice(0, 10)}`,
  );
  log(
    `The server certificate was renewed: it ended ${expires.toISOString().slice(0, 10)}, now ${renewedUntil.toISOString().slice(0, 10)}.`,
  );
  return 'renewed';
}
