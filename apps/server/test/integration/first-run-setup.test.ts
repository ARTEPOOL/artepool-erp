/**
 * The first-run wizard, path "New setup" (decisions 0092, 0102; M6.2 part D): it answers only from
 * the server PC itself, with the installer's one-time token, and only until setup is complete. A
 * full run gives the company, the owner with phone 2-step and 10 recovery codes, and this PC
 * enrolled as the POS; then the wizard is locked for good and the token file is deleted.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SETUP_TOKEN_HEADER,
  clientProofMessage,
  enrollTranscript,
  serverProofMessage,
  type EnrollHelloResponse,
  type SetupDeviceCodeResponse,
  type SetupStatusResponse,
  type SetupTwoStepConfirmResponse,
  type TwoStepStartResponse,
} from '@artepool/shared/contracts';
import { totpCode } from '../../src/platform/auth/totp';
import { newToken, sha256 } from '../../src/platform/crypto/tokens';
import { caFingerprint, deriveCodeKey, proof } from '../../src/modules/devices/enrollment-crypto';
import {
  call,
  errorCode,
  startTestServer,
  type CallOptions,
  type TestServer,
} from '../support/server';

let server: TestServer;
let dir: string;
let tokenFile: string;
const token = randomBytes(32).toString('base64url');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'artepool-setup-'));
  tokenFile = join(dir, 'token');
  await writeFile(tokenFile, `${token}\n`);
  server = await startTestServer(undefined, { setupTokenFile: tokenFile });
});
afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

const asSetup = (extra: CallOptions = {}): CallOptions => ({
  version: null,
  headers: { [SETUP_TOKEN_HEADER]: token },
  ...extra,
});
const setupCall = (method: 'GET' | 'POST' | 'PUT', url: string, extra: CallOptions = {}) =>
  call(server, method, url, asSetup(extra));

const COMPANY = {
  legalNameAr: 'آرتيبول لحمامات السباحة',
  legalNameEn: 'ARTEPOOL Swimming Pools',
  vatRegistered: true,
  trn: '100123456700003',
  addressAr: 'العين، الإمارات',
  addressEn: 'Al Ain, UAE',
};
const OWNER = {
  username: 'mohammed',
  displayNameAr: 'محمد ياسر',
  displayNameEn: 'Mohammed Yasser',
  password: 'blue-pool-water-71',
};

/** The desktop side of enrollment (as the app plays it), for kind "pos". */
async function enrollThisPc(code: string) {
  const clientNonce = randomBytes(32).toString('base64url');
  const hello = (
    await call(server, 'POST', '/api/v1/enroll/hello', { body: { clientNonce } })
  ).json<EnrollHelloResponse>();
  const codeKey = await deriveCodeKey(code, Buffer.from(hello.keySalt, 'base64url'));
  const transcript = enrollTranscript(
    clientNonce,
    hello.serverNonce,
    caFingerprint(hello.caCertificatePem),
  );
  expect(proof(codeKey, serverProofMessage(transcript))).toBe(hello.serverProof);
  const device = {
    deviceCode: 'SERVER-PC',
    deviceName: 'Counter and server',
    deviceKind: 'pos' as const,
    deviceKeyHash: sha256(newToken()).toString('base64url'),
  };
  return call(server, 'POST', '/api/v1/enroll/complete', {
    body: {
      clientNonce,
      serverNonce: hello.serverNonce,
      ...device,
      clientProof: proof(codeKey, clientProofMessage(transcript, device)),
    },
  });
}

describe('the setup wizard refuses', () => {
  it('without the token, with a wrong one, or from another PC on the network', async () => {
    const tries = [
      call(server, 'GET', '/api/v1/setup/status', { version: null }),
      call(server, 'GET', '/api/v1/setup/status', {
        version: null,
        headers: { [SETUP_TOKEN_HEADER]: randomBytes(32).toString('base64url') },
      }),
      setupCall('GET', '/api/v1/setup/status', { remoteAddress: '192.168.1.20' }),
      setupCall('POST', '/api/v1/setup/start', {
        remoteAddress: '192.168.1.20',
        body: { path: 'new' },
      }),
    ];
    for (const response of await Promise.all(tries)) {
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe('SETUP_UNAVAILABLE');
    }
  });

  it('every step before "start"', async () => {
    const response = await setupCall('PUT', '/api/v1/setup/company', { body: COMPANY });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe('PERMISSION_DENIED');
  });
});

describe('a full "New setup"', () => {
  it('starts: not started → in progress (new)', async () => {
    const status = await setupCall('GET', '/api/v1/setup/status');
    expect(status.json<SetupStatusResponse>()).toMatchObject({
      state: 'not_started',
      company: null,
      owner: null,
      posDevice: null,
    });
    const started = await setupCall('POST', '/api/v1/setup/start', { body: { path: 'new' } });
    expect(started.json<SetupStatusResponse>()).toMatchObject({
      state: 'in_progress',
      path: 'new',
    });
    // Starting again changes nothing.
    expect(
      (await setupCall('POST', '/api/v1/setup/start', { body: { path: 'new' } })).statusCode,
    ).toBe(200);
  });

  it('saves the company details with the usual rules; saving again replaces them', async () => {
    const bad = await setupCall('PUT', '/api/v1/setup/company', {
      body: { ...COMPANY, trn: '123' },
    });
    expect(bad.statusCode).toBe(422);
    const saved = await setupCall('PUT', '/api/v1/setup/company', { body: COMPANY });
    expect(saved.statusCode).toBe(200);
    const again = await setupCall('PUT', '/api/v1/setup/company', {
      body: { ...COMPANY, city: 'Al Ain' },
    });
    expect(again.json<{ city: string; rowVersion: number }>()).toMatchObject({
      city: 'Al Ain',
      rowVersion: 2,
    });
  });

  it('creates the owner, refusing a weak password, a bad username and a second owner', async () => {
    const weak = await setupCall('POST', '/api/v1/setup/owner', {
      body: { ...OWNER, password: '1234567890' },
    });
    expect(errorCode(weak)).toBe('PASSWORD_REJECTED');
    expect(
      weak.json<{ error: { details: { problems: string[] } } }>().error.details.problems,
    ).toContain('common');
    const name = await setupCall('POST', '/api/v1/setup/owner', {
      body: { ...OWNER, username: 'no' },
    });
    expect(errorCode(name)).toBe('VALIDATION_FAILED');

    const made = await setupCall('POST', '/api/v1/setup/owner', { body: OWNER });
    expect(made.json<SetupStatusResponse>().owner).toEqual({
      username: 'mohammed',
      displayNameAr: 'محمد ياسر',
      displayNameEn: 'Mohammed Yasser',
      twoStepEnabled: false,
    });
    // The same step again is fine; another owner is not.
    expect((await setupCall('POST', '/api/v1/setup/owner', { body: OWNER })).statusCode).toBe(200);
    const second = await setupCall('POST', '/api/v1/setup/owner', {
      body: { ...OWNER, username: 'someone' },
    });
    expect(errorCode(second)).toBe('OWNER_PROTECTED');
  });

  it('turns on the phone 2-step and gives the 10 recovery codes once', async () => {
    expect(errorCode(await setupCall('POST', '/api/v1/setup/device-code'))).toBe(
      'PERMISSION_DENIED',
    );
    const start = (
      await setupCall('POST', '/api/v1/setup/two-step/start')
    ).json<TwoStepStartResponse>();
    expect(start.uri).toMatch(/^otpauth:\/\/totp\/.*mohammed/);
    const wrong = await setupCall('POST', '/api/v1/setup/two-step/confirm', {
      body: { code: totpCode(start.secret, Date.now() - 10 * 60_000) },
    });
    expect(errorCode(wrong)).toBe('INVALID_TWO_STEP_CODE');
    const done = await setupCall('POST', '/api/v1/setup/two-step/confirm', {
      body: { code: totpCode(start.secret) },
    });
    expect(done.statusCode).toBe(200);
    const codes = done.json<SetupTwoStepConfirmResponse>().recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    // Already on: it cannot be set up again from the wizard.
    expect(errorCode(await setupCall('POST', '/api/v1/setup/two-step/start'))).toBe(
      'PERMISSION_DENIED',
    );
    const { rows } = await server.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM auth.recovery_codes r JOIN auth.users u ON u.id = r.user_id
        WHERE u.username = 'mohammed' AND r.revoked_at IS NULL`,
    );
    expect(Number(rows[0]!.n)).toBe(10);
  });

  it('will not complete before this PC is enrolled as the POS', async () => {
    const early = await setupCall('POST', '/api/v1/setup/complete');
    expect(errorCode(early)).toBe('PERMISSION_DENIED');
    expect(
      early.json<{ error: { details: { missing: string[] } } }>().error.details.missing,
    ).toEqual(['posDevice']);
  });

  it('enrolls this PC as the POS with a one-time code, then completes and locks for good', async () => {
    const code = (
      await setupCall('POST', '/api/v1/setup/device-code')
    ).json<SetupDeviceCodeResponse>();
    expect((await enrollThisPc(code.code)).statusCode).toBe(201);
    expect(
      (await setupCall('GET', '/api/v1/setup/status')).json<SetupStatusResponse>().posDevice,
    ).toEqual({
      code: 'SERVER-PC',
      name: 'Counter and server',
    });
    const done = await setupCall('POST', '/api/v1/setup/complete');
    expect(done.json()).toEqual({ state: 'complete' });
    expect(existsSync(tokenFile)).toBe(false);

    // The token is gone: nothing answers any more.
    expect(errorCode(await setupCall('GET', '/api/v1/setup/status'))).toBe('SETUP_UNAVAILABLE');
    // Even with a token file put back, every step says setup is done.
    await writeFile(tokenFile, token);
    expect((await setupCall('GET', '/api/v1/setup/status')).json<SetupStatusResponse>().state).toBe(
      'complete',
    );
    for (const [method, url, body] of [
      ['POST', '/api/v1/setup/start', { path: 'new' }],
      ['PUT', '/api/v1/setup/company', COMPANY],
      ['POST', '/api/v1/setup/owner', { ...OWNER, username: 'other' }],
      ['POST', '/api/v1/setup/device-code', undefined],
      ['POST', '/api/v1/setup/complete', undefined],
    ] as const) {
      const response = await setupCall(method, url, body ? { body } : {});
      expect(
        response.json<{ error: { details: { rule?: string } } }>().error.details.rule,
        url,
      ).toBe('SETUP_ALREADY_DONE');
    }
  });

  it('wrote every step to the audit log as SYSTEM with "setup wizard"', async () => {
    const { rows } = await server.admin.query<{ what: string; user_id: string; reason: string }>(
      `SELECT coalesce(entity_type, '') || ' ' || action AS what, user_id::text, reason FROM audit.log
        WHERE reason = 'setup wizard' ORDER BY id`,
    );
    const what = rows.map((r) => r.what);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set(['1']));
    for (const step of [
      'sys.setup_state update',
      'sys.company_profile insert',
      'auth.users insert',
      'auth.users event:auth.owner_created',
      'auth.users event:auth.two_step_enabled',
      'auth.enrollment_codes insert',
    ]) {
      expect(what, step).toContain(step);
    }
  });
});
