/**
 * The server side of the Playwright tests (started by playwright.config.ts):
 *
 * - the real API over HTTPS (TLS 1.3, its own ARTÉPOOL CA) on a throwaway database;
 * - the office PC and the POS PC enrolled through the real enrollment protocol;
 * - a control endpoint on 127.0.0.1 so tests can add users, create enrollment codes, read the
 *   owner's current 2-step code, and stop or start the server.
 *
 * Everything is removed when the run ends. It never touches the development database.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadEnv } from '@artepool/node-kit';

loadEnv();
// A database name of its own, so a test run of the API at the same time is not disturbed.
process.env.ARTEPOOL_TEST_DB = `${process.env.ARTEPOOL_TEST_DB ?? 'artepool_test'}_e2e`;
// A4 PDFs: the same browser the screen tests use, when one is named.
if (process.env.ARTEPOOL_E2E_CHROMIUM)
  process.env.ARTEPOOL_CHROMIUM ??= process.env.ARTEPOOL_E2E_CHROMIUM;

const { inContext, prepareTestTemplate } = await import('@artepool/testing');
const backup = await import('@artepool/backup');
const age = await import('age-encryption');
const support = await import('@artepool/server/test-support');
const { DevBridge } = await import('@artepool/dev-bridge');
const { E2E } = await import('../paths');

const OWNER = {
  username: 'owner',
  password: 'blue-pool-water-owner',
  displayNameAr: 'محمد المالك',
  displayNameEn: 'Mohammed Owner',
};

// Sign-in limits are tested by the API tests; here many flows share one PC within a minute.
const generous = () => ({
  unknownDevice: new support.RateLimiter(1000, 60_000),
  signIn: new support.RateLimiter(1000, 60_000),
  enrollment: new support.RateLimiter(1000, 60_000),
});

const dropTemplate = await prepareTestTemplate();
const server = await support.startTestServer(undefined, { limits: generous() });
const https = await support.listenHttps(server);
const owner = await support.addOwnerWithTwoStep(server, OWNER);

async function newCode(): Promise<string> {
  const created = await support.withBusinessTx(
    server.db,
    { userId: 1n, requestId: randomUUID(), reason: 'e2e enrollment code' },
    (trx) => support.createEnrollmentCode(trx, server.deps, 'console'),
  );
  return created.code;
}

await rm(E2E.stateDir, { recursive: true, force: true });
await mkdir(E2E.stateDir, { recursive: true, mode: 0o700 });
for (const pc of [
  { ...E2E.pcs.office, deviceCode: 'OFFICE-01', deviceName: 'مكتب المالك', kind: 'office' },
  { ...E2E.pcs.pos, deviceCode: 'COUNTER-01', deviceName: 'كاشير المعرض', kind: 'pos' },
] as const) {
  const bridge = new DevBridge({ deviceFile: pc.deviceFile, clientVersion: '0.1.0' });
  const outcome = await bridge.enroll({
    serverAddress: https.url,
    code: await newCode(),
    deviceCode: pc.deviceCode,
    deviceName: pc.deviceName,
    deviceKind: pc.kind,
  });
  if (!outcome.ok) throw new Error(`Could not enroll ${pc.deviceCode}: ${outcome.reason}`);
}

/** A 2-step user's current code (the owner's by default), never one already used. */
async function currentCode(userId: bigint = owner.id): Promise<string> {
  const row = await server.db
    .selectFrom('auth.users')
    .select(['totp_secret_enc', 'totp_last_step'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  if (!row.totp_secret_enc) throw new Error('This user has no 2-step code set up.');
  const secret = server.deps.secretBox
    .open(row.totp_secret_enc, `auth.users.totp_secret_enc:${userId}`)
    .toString('utf8');
  const current = Math.floor(Date.now() / 30_000);
  const step = Math.max(current, Number(row.totp_last_step ?? -1) + 1);
  // The server accepts one step ahead; any later and we wait for time to catch up.
  if (step > current + 1) await new Promise((r) => setTimeout(r, (step - 1) * 30_000 - Date.now()));
  return support.totpCode(secret, step * 30_000 + 1_000);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)));
}

/**
 * The server PC right after installation (decision 0102): a server of its own on a fresh,
 * empty database, the installer's setup token, and the "setup" PC pointed at it, not enrolled.
 * Made again for each wizard test (the wizard deletes the token when it completes).
 */
let setupServer: { server: typeof server; https: typeof https } | null = null;

/**
 * Restore from a backup (decision 0102): the "USB drive" the setup PC finds copies on, and the
 * restore program's settings for the setup server (its database, its backups folder, the master
 * key file it puts the copy's key into). Every test server uses the same master key.
 */
const RESTORE = {
  usb: join(E2E.stateDir, 'restore', 'usb'),
  backups: join(E2E.stateDir, 'restore', 'backups'),
  old: join(E2E.stateDir, 'restore', 'old'),
  masterKey: join(E2E.stateDir, 'restore', 'master.key'),
  keyFile: join(E2E.stateDir, 'restore', 'artepool-backup-key.txt'),
};
const TEST_MASTER_KEY = Buffer.alloc(32, 42);
async function newSetupServer(): Promise<void> {
  if (setupServer) {
    await setupServer.https.close();
    await setupServer.server.close();
  }
  const tokenFile = join(E2E.stateDir, 'setup-token');
  const caFile = join(E2E.stateDir, 'setup-ca.crt');
  await writeFile(tokenFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const fresh = await support.startTestServer(undefined, {
    limits: generous(),
    setupTokenFile: tokenFile,
  });
  const listening = await support.listenHttps(fresh);
  await writeFile(caFile, listening.ca.certPem);
  await rm(RESTORE.usb, { recursive: true, force: true });
  await mkdir(RESTORE.usb, { recursive: true });
  await writeFile(RESTORE.masterKey, TEST_MASTER_KEY.toString('base64'), { mode: 0o600 });
  await writeFile(
    E2E.setupFile,
    JSON.stringify({
      serverAddress: listening.url,
      caFile,
      tokenFile,
      restore: {
        places: [RESTORE.usb],
        env: {
          ARTEPOOL_DB: fresh.testDb.name,
          ARTEPOOL_BACKUP_DIR: RESTORE.backups,
          ARTEPOOL_MASTER_KEY_FILE: RESTORE.masterKey,
        },
      },
    }),
  );
  await rm(E2E.pcs.setup.deviceFile, { force: true });
  setupServer = { server: fresh, https: listening };
}

const routes: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  'POST /setup-server': async () => {
    await newSetupServer();
    return {};
  },
  /**
   * The shop's off-site copy: the main server's data (its setup finished), encrypted with its
   * master key for a new backup key, put on the setup PC's "USB drive"; the key file beside it.
   */
  'POST /restore-copy': async () => {
    const { rows } = await server.admin.query<{ state: string }>(
      'SELECT state FROM sys.setup_state',
    );
    if (rows[0]?.state !== 'complete') {
      await inContext(server.admin, async () => {
        await server.admin.query(`UPDATE sys.setup_state SET state = 'in_progress', path = 'new'`);
        await server.admin.query(`UPDATE sys.setup_state SET state = 'complete'`);
      });
    }
    const config = { ...backup.configFromEnv(server.testDb.name), backupDir: RESTORE.old };
    const client = await backup.connect(config.connection);
    const copy = await backup.localBackup(client, config).finally(() => client.end());
    const identity = await age.generateX25519Identity();
    const recipient = await age.identityToRecipient(identity);
    const name = `${copy.fileName}.age`;
    await writeFile(
      join(RESTORE.usb, name),
      await backup.encryptBundle(
        await readFile(copy.path),
        copy.fileName,
        TEST_MASTER_KEY,
        recipient,
      ),
    );
    await writeFile(
      RESTORE.keyFile,
      `# created: ${new Date().toISOString()}\n# public key: ${recipient}\n${identity}\n`,
    );
    return { name, keyFile: RESTORE.keyFile };
  },
  'GET /ready': () => Promise.resolve({ ready: true, api: https.url }),
  'GET /owner': () => Promise.resolve({ username: OWNER.username, password: OWNER.password }),
  'POST /owner/code': async () => ({ code: await currentCode() }),
  /** A staff member who signs in with the 2-step code, with known recovery codes. */
  'POST /two-step-users': async (input) => {
    const { id } = await support.addOwnerWithTwoStep(server, {
      ...(input as unknown as Parameters<typeof support.addOwnerWithTwoStep>[1]),
      roles: ['accountant'],
    });
    return { id };
  },
  'POST /code': async (input) => ({ code: await currentCode(BigInt(String(input.userId))) }),
  'POST /owner/reset-2fa': async () => {
    await support.resetOwnerTwoStep(server.db, 'e2e: set up the 2-step code again');
    return {};
  },
  'POST /users': async (input) => ({
    id: await support.addUser(server, input as unknown as Parameters<typeof support.addUser>[1]),
  }),
  'POST /enrollment-code': async () => ({ code: await newCode() }),
  /** A stock item with a barcode, a price and opening stock (and the company details once). */
  'POST /pos-item': async (input) =>
    support.addPosItem(
      server,
      owner.id,
      input as unknown as Parameters<typeof support.addPosItem>[2],
    ),
  /** A credit customer, optionally with an overdue opening balance (decision 0114). */
  'POST /credit-customer': async (input) =>
    support.addCreditCustomer(
      server,
      owner.id,
      input as unknown as Parameters<typeof support.addCreditCustomer>[2],
    ),
  /** Enrolls one more PC through the real protocol (for tests that revoke a PC). */
  'POST /devices': async (input) => {
    const deviceCode = typeof input.code === 'string' ? input.code : 'EXTRA-PC';
    const deviceName = typeof input.name === 'string' ? input.name : deviceCode;
    const bridge = new DevBridge({
      deviceFile: `${E2E.stateDir}/${deviceCode}.json`,
      clientVersion: '0.1.0',
    });
    const outcome = await bridge.enroll({
      serverAddress: https.url,
      code: await newCode(),
      deviceCode,
      deviceName,
      deviceKind: 'office',
    });
    if (!outcome.ok) throw new Error(`Could not enroll ${deviceCode}: ${outcome.reason}`);
    return outcome.device;
  },
  /** A cashier's open shift on a POS PC of its own, to close from another PC (decision 0069). */
  'POST /stuck-shift': async (input) => {
    const code = String(input.code);
    const pc = await support.addDevice(server, { code, kind: 'pos' });
    const userId = await support.addUser(server, {
      username: String(input.username),
      displayNameAr: String(input.displayName),
      displayNameEn: String(input.displayName),
      roles: ['cashier'],
      pin: '4829',
    });
    const { token } = await support.openSession(server, { userId, deviceId: pc.id });
    const opened = await support.call(server, 'POST', '/api/v1/shifts', {
      device: pc,
      token,
      idempotencyKey: randomUUID(),
      body: { openingFloatFils: String(input.floatFils) },
    });
    if (opened.statusCode !== 201) throw new Error(`Could not open the shift: ${opened.body}`);
    return opened.json<{ shiftNumber: string }>();
  },
  'POST /server/stop': async () => {
    await https.stop();
    return {};
  },
  'POST /server/start': async () => {
    await https.start();
    return {};
  },
};

const control = createServer((request, response) => {
  const handler = routes[`${request.method} ${request.url}`];
  if (!handler) return send(response, 404, { error: 'not found' });
  body(request)
    .then(handler)
    .then((value) => send(response, 200, value))
    .catch((error: Error) => send(response, 500, { error: error.message }));
});
control.listen(Number(new URL(E2E.control).port), '127.0.0.1');
console.log(`e2e harness ready: API ${https.url}, control ${E2E.control}`);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  control.close();
  if (setupServer) {
    await setupServer.https.close();
    await setupServer.server.close();
  }
  await https.close();
  await server.close();
  await dropTemplate();
  await rm(E2E.stateDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
