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
import { mkdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '@artepool/node-kit';

loadEnv();
// A database name of its own, so a test run of the API at the same time is not disturbed.
process.env.ARTEPOOL_TEST_DB = `${process.env.ARTEPOOL_TEST_DB ?? 'artepool_test'}_e2e`;

const { prepareTestTemplate } = await import('@artepool/testing');
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

/** The owner's current 2-step code, never one already used (codes work once). */
async function ownerCode(): Promise<string> {
  const row = await server.db
    .selectFrom('auth.users')
    .select(['totp_secret_enc', 'totp_last_step'])
    .where('id', '=', owner.id)
    .executeTakeFirstOrThrow();
  if (!row.totp_secret_enc) throw new Error('The owner has no 2-step code set up.');
  const secret = server.deps.secretBox
    .open(row.totp_secret_enc, `auth.users.totp_secret_enc:${owner.id}`)
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

const routes: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  'GET /ready': () => Promise.resolve({ ready: true, api: https.url }),
  'GET /owner': () => Promise.resolve({ username: OWNER.username, password: OWNER.password }),
  'POST /owner/code': async () => ({ code: await ownerCode() }),
  'POST /owner/reset-2fa': async () => {
    await support.resetOwnerTwoStep(server.db, 'e2e: set up the 2-step code again');
    return {};
  },
  'POST /users': async (input) => ({
    id: await support.addUser(server, input as unknown as Parameters<typeof support.addUser>[1]),
  }),
  'POST /enrollment-code': async () => ({ code: await newCode() }),
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
  await https.close();
  await server.close();
  await dropTemplate();
  await rm(E2E.stateDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
