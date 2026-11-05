/**
 * The rehearsal's server and its people (M7, decision 0119): the real API (the same routes,
 * permission checks, approvals, idempotency and audit as the shop's server), running in this
 * process on the rehearsal's own database, with a throwaway master key that exists only in
 * memory. Requests go through the server's request pipeline (Fastify inject) exactly as the PCs'
 * requests do, minus the network; the PCs enroll through the normal enrollment flow and people
 * sign in through the real sign-in API (password and 2-step code, or the cashier's PIN on a POS).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import type { ApprovalResponse, EnrollHelloResponse } from '@artepool/shared/contracts';
import {
  clientProofMessage,
  enrollTranscript,
  serverProofMessage,
} from '@artepool/shared/contracts';
import { connectionFor } from '@artepool/node-kit';
import { buildApp } from '../app';
import { SecretBox } from '../platform/crypto/secret-box';
import { newToken, sha256 } from '../platform/crypto/tokens';
import { totpCode } from '../platform/auth/totp';
import { createDb, createPool, type Db } from '../platform/db/pool';
import { stamped } from '../platform/db/stamped';
import { withBusinessTx } from '../platform/db/tx';
import { createDeps, type AppDeps } from '../platform/http/deps';
import { createEnrollmentCode } from '../modules/devices/service';
import { caFingerprint, deriveCodeKey, proof } from '../modules/devices/enrollment-crypto';
import { totpAad } from '../modules/auth/service';

/** Stands in for the shop's CA certificate: the enrollment only needs its fingerprint. */
const REHEARSAL_CA_PEM =
  '-----BEGIN CERTIFICATE-----\nARTEPOOL-REHEARSAL-CA\n-----END CERTIFICATE-----\n';

export class RehearsalError extends Error {}

export interface Pc {
  id: bigint;
  key: string;
  code: string;
  kind: 'pos' | 'office';
  /** The PC's own address on the shop's network: the server's limits count per PC, as in the shop. */
  ip: string;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';

/** A signed-in person on a PC: calls the API as the desktop app does. */
export interface Actor {
  (method: Method, url: string, body?: unknown): Promise<unknown>;
  raw: (method: Method, url: string, body?: unknown) => Promise<LightMyRequestResponse>;
  userId: bigint;
  username: string;
  pc: Pc;
}

/** Someone who gives approvals with the one-time codes of their 2-step app (decision 0074). */
interface Approver {
  userId: bigint;
  secret: string;
  lastStep: number;
}

const PERIOD_MS = 30_000;

export class RehearsalServer {
  private approvers: Approver[] = [];
  private nextApprover = 0;
  private pcs = 0;

  private constructor(
    readonly app: FastifyInstance,
    readonly db: Db,
    readonly deps: AppDeps,
    /** The app version the PCs report: the oldest one this server accepts. */
    private readonly clientVersion: string,
  ) {}

  static async start(databaseName: string): Promise<RehearsalServer> {
    const db = createDb(createPool(connectionFor('api', databaseName), 10));
    const deps = createDeps({
      db,
      // The rehearsal's own master key: never written anywhere, gone with the process.
      secretBox: SecretBox.fromKey(randomBytes(32)),
      caCertificatePem: REHEARSAL_CA_PEM,
      updates: {
        fetchLatest: () => Promise.reject(new Error('No update checks during a rehearsal')),
        wake: () => undefined,
      },
    });
    // The shop's own limits stay on (each rehearsal PC has its own address, as in the shop).
    const app = buildApp({ logLevel: 'warn' }, deps);
    await app.ready();
    return new RehearsalServer(app, db, deps, await deps.settings.text('client.min_version'));
  }

  async close(): Promise<void> {
    await this.app.close();
    await this.db.destroy();
  }

  /** One request, the way the desktop app sends it. */
  inject(
    method: Method,
    url: string,
    options: { pc?: Pc | null; ip?: string; token?: string | null; body?: unknown } = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { 'x-artepool-client': this.clientVersion };
    if (options.pc) headers['x-artepool-device'] = options.pc.key;
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (method !== 'GET') headers['idempotency-key'] = randomUUID();
    return this.app.inject({
      method,
      url,
      headers,
      remoteAddress: options.pc?.ip ?? options.ip ?? '192.168.50.2',
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
    });
  }

  /** The first PC, enrolled with a code from the server console (as on a new installation). */
  async consoleCode(): Promise<string> {
    const { code } = await withBusinessTx(
      this.db,
      { userId: 1n, requestId: randomUUID(), reason: 'rehearsal: the first PC' },
      (trx) => createEnrollmentCode(trx, this.deps, 'console'),
    );
    return code;
  }

  /** Enrolls a PC with a one-time code, through enroll/hello and enroll/complete. */
  async enroll(code: string, deviceCode: string, kind: 'pos' | 'office'): Promise<Pc> {
    const ip = `192.168.50.${10 + this.pcs++}`;
    const clientNonce = randomBytes(32).toString('base64url');
    const hello = ok<EnrollHelloResponse>(
      await this.inject('POST', '/api/v1/enroll/hello', { ip, body: { clientNonce } }),
      'enroll/hello',
    );
    const codeKey = await deriveCodeKey(code, Buffer.from(hello.keySalt, 'base64url'));
    const transcript = enrollTranscript(
      clientNonce,
      hello.serverNonce,
      caFingerprint(hello.caCertificatePem),
    );
    if (proof(codeKey, serverProofMessage(transcript)) !== hello.serverProof)
      throw new RehearsalError('The server did not prove it knows the enrollment code');
    const key = newToken();
    const device = {
      deviceCode,
      deviceName: `Rehearsal ${deviceCode}`,
      deviceKind: kind,
      deviceKeyHash: sha256(key).toString('base64url'),
    };
    const done = ok<{ device: { id: string } }>(
      await this.inject('POST', '/api/v1/enroll/complete', {
        ip,
        body: {
          clientNonce,
          serverNonce: hello.serverNonce,
          ...device,
          clientProof: proof(codeKey, clientProofMessage(transcript, device)),
        },
      }),
      'enroll/complete',
    );
    return { id: BigInt(done.device.id), key, code: deviceCode, kind, ip };
  }

  /**
   * A member of staff, as Settings → Users makes them, ready to work: a password (and 2-step
   * code) or a PIN, the role, no first-time change pending.
   */
  async staff(input: {
    username: string;
    role: string;
    password?: string;
    pin?: string;
    totpSecret?: string;
  }): Promise<bigint> {
    const method = input.pin ? 'pin' : input.totpSecret ? 'password_totp' : 'password';
    const passwordHash = input.password ? await this.deps.hasher.hash(input.password) : null;
    const pinHash = input.pin ? await this.deps.hasher.hash(input.pin) : null;
    return withBusinessTx(
      this.db,
      { userId: 1n, requestId: randomUUID(), reason: 'rehearsal: staff' },
      async (trx) => {
        const user = await trx
          .insertInto('auth.users')
          .values(
            stamped('auth.users', {
              username: input.username,
              display_name_ar: input.username,
              display_name_en: input.username,
              sign_in_method: method,
              password_hash: passwordHash,
              pin_hash: pinHash,
              password_changed_at: passwordHash ? sql<Date>`now()` : null,
              must_change_password: false,
              pin_must_change: false,
            }),
          )
          .returning('id')
          .executeTakeFirstOrThrow();
        await sql`INSERT INTO auth.user_roles (user_id, role_id)
                  SELECT ${user.id}, id FROM auth.roles WHERE code = ${input.role}`.execute(trx);
        if (input.totpSecret) {
          await trx
            .updateTable('auth.users')
            .set({
              totp_secret_enc: this.deps.secretBox.seal(
                Buffer.from(input.totpSecret, 'utf8'),
                totpAad(user.id),
              ),
              totp_enabled: true,
            })
            .where('id', '=', user.id)
            .execute();
        }
        return user.id;
      },
    );
  }

  /** Signs in with a password and, when the account has one, the 2-step code. */
  async signIn(pc: Pc, username: string, password: string, totpSecret?: string): Promise<Actor> {
    const first = ok<{ token: string; session: { stage: string }; user: { id: string } }>(
      await this.inject('POST', '/api/v1/auth/sign-in', { pc, body: { username, password } }),
      `sign-in ${username}`,
    );
    let token = first.token;
    if (first.session.stage === 'second_factor') {
      if (!totpSecret) throw new RehearsalError(`${username} needs a 2-step code`);
      const second = ok<{ token?: string }>(
        await this.inject('POST', '/api/v1/auth/second-factor', {
          pc,
          token,
          body: { code: await this.freshCode(BigInt(first.user.id), totpSecret) },
        }),
        `2-step ${username}`,
      );
      token = second.token ?? token;
    }
    return this.actor(pc, BigInt(first.user.id), username, token);
  }

  /** A cashier signs in with their PIN on a POS PC (decision 0021). */
  async signInPin(pc: Pc, userId: bigint, username: string, pin: string): Promise<Actor> {
    const done = ok<{ token: string }>(
      await this.inject('POST', '/api/v1/auth/pin-sign-in', {
        pc,
        body: { userId: userId.toString(), pin },
      }),
      `PIN sign-in ${username}`,
    );
    return this.actor(pc, userId, username, done.token);
  }

  actor(pc: Pc, userId: bigint, username: string, token: string): Actor {
    const raw = (method: Method, url: string, body?: unknown) =>
      this.inject(method, url, { pc, token, body });
    const fn = async (method: Method, url: string, body?: unknown) =>
      ok(await raw(method, url, body), `${method} ${url} as ${username}`);
    return Object.assign(fn, { raw, userId, username, pc });
  }

  /** The people who approve, in turn, with their 2-step codes. */
  addApprover(userId: bigint, secret: string): void {
    this.approvers.push({ userId, secret, lastStep: 0 });
  }

  /**
   * A supervisor's approval for `requester`'s action (decision 0074), given with a one-time code
   * from the approver's 2-step app. Each code is used once; the approvers take turns, and wait
   * for the next code only when they must.
   */
  async approval(requester: Actor, permission: string, context: object = {}): Promise<string> {
    const candidates = this.approvers.filter((a) => a.userId !== requester.userId);
    if (candidates.length === 0) throw new RehearsalError('No approver is set up');
    const approver = candidates[this.nextApprover++ % candidates.length]!;
    const code = await this.nextCode(approver);
    const answer = ok<ApprovalResponse>(
      await requester.raw('POST', '/api/v1/approvals', {
        permission,
        approverId: approver.userId.toString(),
        code,
        reason: 'Rehearsal: approved at the counter',
        ...(Object.keys(context).length > 0 ? { context } : {}),
      }),
      `approval ${permission}`,
    );
    return answer.approvalId;
  }

  /**
   * A code newer than the last one this person used (each is accepted once): the current step's,
   * or the one before (still accepted, one step of clock difference, decision 0022), or the next
   * step's once its time has come.
   */
  private async nextCode(approver: Approver): Promise<string> {
    const step = (t: number) => Math.floor(t / PERIOD_MS);
    const use = Math.max(step(Date.now()) - 1, approver.lastStep + 1);
    approver.lastStep = use;
    while (use > step(Date.now()) + 1) {
      const now = Date.now();
      await new Promise((resolve) => setTimeout(resolve, (step(now) + 1) * PERIOD_MS - now + 50));
    }
    return totpCode(approver.secret, use * PERIOD_MS + 1);
  }

  private async freshCode(userId: bigint, secret: string): Promise<string> {
    const known = this.approvers.find((a) => a.userId === userId);
    if (known) return this.nextCode(known);
    return totpCode(secret);
  }
}

/** The answer's body, or a clear error naming the step and the server's error code. */
export function ok<T>(response: LightMyRequestResponse, step: string): T {
  if (response.statusCode >= 400) {
    let code = String(response.statusCode);
    try {
      const body = response.json<{ error?: { code?: string; details?: unknown } }>();
      code = `${response.statusCode} ${body.error?.code ?? ''} ${JSON.stringify(body.error?.details ?? {})}`;
    } catch {
      // Not JSON: the status says enough.
    }
    throw new RehearsalError(`${step}: ${code}`);
  }
  return (response.body === '' ? null : response.json()) as T;
}
