/**
 * The PC side against a real HTTPS server (decision 0024): enrolling with the one-time code,
 * trusting only the ARTÉPOOL CA afterwards, the server going away, and key renewal.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ageRow,
  createEnrollmentCode,
  listenHttps,
  startTestServer,
  withBusinessTx,
  type HttpsTestServer,
  type TestServer,
} from '@artepool/server/test-support';
import type { BridgeResponse, ThisDeviceResponse } from '@artepool/shared/contracts';
import { DevBridge, keyHash, readDevice, writeDevice } from '../../src';

let server: TestServer;
let https: HttpsTestServer;

beforeAll(async () => {
  server = await startTestServer();
  https = await listenHttps(server);
});
afterAll(async () => {
  await https.close();
  await server.close();
});

async function newCode(): Promise<string> {
  const created = await withBusinessTx(
    server.db,
    { userId: 1n, requestId: randomUUID(), reason: 'test enrollment code' },
    (trx) => createEnrollmentCode(trx, server.deps, 'console'),
  );
  return created.code;
}

async function newPc(name = 'TEST-PC') {
  const dir = await mkdtemp(join(tmpdir(), 'artepool-pc-'));
  const deviceFile = join(dir, 'device.json');
  return {
    deviceFile,
    bridge: new DevBridge({ deviceFile, clientVersion: '0.1.0', computerName: name }),
  };
}

const input = (code: string, deviceCode = 'COUNTER-01') => ({
  serverAddress: https.url,
  code,
  deviceCode,
  deviceName: 'Showroom counter',
  deviceKind: 'pos' as const,
});

const status = (answer: BridgeResponse) =>
  answer.kind === 'response' ? answer.status : answer.kind;
const meOf = (bridge: DevBridge) => bridge.request({ method: 'GET', path: '/api/v1/devices/me' });

describe('enrolling this PC', () => {
  it('works with the right code; the PC keeps the CA and its own key, never the code', async () => {
    const pc = await newPc('counter-01');
    expect(await pc.bridge.localDevice()).toEqual({
      enrolled: false,
      serverUrl: null,
      device: null,
      suggestedCode: 'COUNTER-01',
    });
    expect(await meOf(pc.bridge)).toEqual({ kind: 'not_enrolled' });

    const code = await newCode();
    const outcome = await pc.bridge.enroll(input(code));
    expect(outcome).toMatchObject({
      ok: true,
      serverUrl: https.url,
      device: { code: 'COUNTER-01' },
    });

    const stored = await readDevice(pc.deviceFile);
    expect(stored?.caCertificatePem).toBe(https.ca.certPem);
    expect((await pc.bridge.localDevice()).device).toEqual({
      code: 'COUNTER-01',
      name: 'Showroom counter',
      kind: 'pos',
    });
    expect((await stat(pc.deviceFile)).mode & 0o777).toBe(0o600);
    const text = await readFile(pc.deviceFile, 'utf8');
    expect(text).not.toContain(code);
    expect(text).not.toContain(code.replaceAll('-', ''));

    const me = await meOf(pc.bridge);
    expect(status(me)).toBe(200);
    expect((me as { body: ThisDeviceResponse }).body.device).toMatchObject({
      code: 'COUNTER-01',
      name: 'Showroom counter',
      kind: 'pos',
    });
    // The server stores only the SHA-256 of the key.
    const row = await server.db
      .selectFrom('auth.devices')
      .select('key_hash')
      .where('code', '=', 'COUNTER-01')
      .executeTakeFirstOrThrow();
    expect(row.key_hash.toString('base64url')).toBe(keyHash(stored!.deviceKey));
  });

  it('refuses to trust the server when the code is wrong (no file is written)', async () => {
    await newCode();
    const pc = await newPc();
    expect(await pc.bridge.enroll(input('ZZZ-ZZZ-ZZZ', 'WRONG-PC'))).toEqual({
      ok: false,
      reason: 'not_genuine',
    });
    expect(await readDevice(pc.deviceFile)).toBeNull();
  });

  it('explains an address it cannot use or reach', async () => {
    const pc = await newPc();
    expect(await pc.bridge.enroll({ ...input('X'), serverAddress: 'http://plain' })).toEqual({
      ok: false,
      reason: 'invalid_address',
    });
    expect(await pc.bridge.enroll({ ...input('X'), serverAddress: 'https://127.0.0.1:1' })).toEqual(
      { ok: false, reason: 'unreachable' },
    );
  });
});

describe('after enrollment', () => {
  let pc: Awaited<ReturnType<typeof newPc>>;
  beforeAll(async () => {
    pc = await newPc();
    const outcome = await pc.bridge.enroll(input(await newCode(), 'AFTER-PC'));
    expect(outcome.ok).toBe(true);
  });

  it('trusts only the ARTÉPOOL CA: another server at that address is refused', async () => {
    const otherDb = await startTestServer();
    const other = await listenHttps(otherDb);
    try {
      const stored = (await readDevice(pc.deviceFile))!;
      const pointed = await newPc();
      await writeDevice(pointed.deviceFile, { ...stored, serverUrl: other.url });
      expect(await meOf(pointed.bridge)).toEqual({ kind: 'untrusted' });
    } finally {
      await other.close();
      await otherDb.close();
    }
  });

  it('reports the server as unreachable while it is stopped, and recovers', async () => {
    await https.stop();
    try {
      expect(await meOf(pc.bridge)).toEqual({ kind: 'unreachable' });
    } finally {
      await https.start();
    }
    expect(status(await meOf(pc.bridge))).toBe(200);
  });

  it('renews its key 30 days before it expires; the old key stops working', async () => {
    const before = (await readDevice(pc.deviceFile))!;
    await ageRow(
      server,
      `UPDATE auth.devices SET enrolled_at = now() - interval '355 days',
              key_expires_at = now() + interval '10 days' WHERE id = $1`,
      [before.device.id],
    );
    await writeDevice(pc.deviceFile, {
      ...before,
      keyExpiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    });
    expect(status(await meOf(pc.bridge))).toBe(200);
    const after = (await readDevice(pc.deviceFile))!;
    expect(after.deviceKey).not.toBe(before.deviceKey);
    expect(after.pendingKey).toBeUndefined();
    expect(Date.parse(after.keyExpiresAt) - Date.now()).toBeGreaterThan(360 * 86_400_000);

    const stale = await newPc();
    await writeDevice(stale.deviceFile, before);
    const old = await stale.bridge.request({ method: 'GET', path: '/health' });
    expect(status(old)).toBe(200); // the health check needs no key
    const refused = await meOf(stale.bridge);
    expect(status(refused)).toBe(401);
  });

  it('recovers from a renewal whose answer was lost (the pending key is tried)', async () => {
    const stored = (await readDevice(pc.deviceFile))!;
    const pendingKey = 'p'.repeat(43);
    // The server took the new key, but the PC never heard back.
    await withBusinessTx(
      server.db,
      { userId: 1n, requestId: randomUUID(), reason: 'test: renewal answer lost' },
      (trx) =>
        trx
          .updateTable('auth.devices')
          .set({ key_hash: Buffer.from(keyHash(pendingKey), 'base64url') })
          .where('id', '=', BigInt(stored.device.id))
          .execute(),
    );
    await writeDevice(pc.deviceFile, { ...stored, pendingKey });
    expect(status(await meOf(pc.bridge))).toBe(200);
    const after = (await readDevice(pc.deviceFile))!;
    expect(after.deviceKey).toBe(pendingKey);
    expect(after.pendingKey).toBeUndefined();
  });
});
