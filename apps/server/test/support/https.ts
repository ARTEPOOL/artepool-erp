/**
 * A real HTTPS listener (TLS 1.3, its own ARTÉPOOL CA) around a test server, for tests that play
 * the PC side over the network: the desktop dev bridge and the Playwright screen tests.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createCa, issueServerCert, type PemPair } from '@artepool/tls';
import { buildApp } from '../../src/app';
import type { UpdateProgress } from '../../src/cli/upgrade/progress';
import { createStatusServer } from '../../src/cli/upgrade/status-server';
import { newTotpSecret } from '../../src/platform/auth/totp';
import { normalizeCode } from '../../src/platform/crypto/codes';
import { withBusinessTx } from '../../src/platform/db/tx';
import { addUser, type TestServer, type UserOptions } from './server';

export interface HttpsTestServer {
  /** e.g. `https://localhost:43125` */
  url: string;
  port: number;
  ca: PemPair;
  /** Stops answering (the "main server unreachable" case); `start()` brings it back. */
  stop(): Promise<void>;
  start(): Promise<void>;
  /**
   * The server is being updated (decision 0115): it stops, and the real status page answers on
   * its port with these steps; called again, the steps change. `endUpdate()` closes the page.
   */
  showUpdate(progress: UpdateProgress): Promise<void>;
  endUpdate(): Promise<void>;
  close(): Promise<void>;
}

export async function listenHttps(
  server: TestServer,
  options: { port?: number; logLevel?: 'silent' | 'info' } = {},
): Promise<HttpsTestServer> {
  const names = { dns: ['localhost'], ips: ['127.0.0.1'] };
  const ca = await createCa(names);
  const cert = await issueServerCert(ca, names);
  // Enrollment hands out this CA, so the PC side can pin it (decision 0024).
  const deps = { ...server.deps, caCertificatePem: ca.certPem };
  let app: FastifyInstance | null = null;
  let port = options.port ?? 0;

  const start = async () => {
    if (app) return;
    const next = buildApp(
      {
        logLevel: options.logLevel ?? 'silent',
        https: { cert: cert.certPem, key: cert.keyPem },
      },
      deps,
    );
    await next.listen({ host: '127.0.0.1', port });
    port = (next.server.address() as AddressInfo).port;
    app = next;
  };
  const stop = async () => {
    const current = app;
    app = null;
    await current?.close();
  };
  let page: Server | null = null;
  let progress: UpdateProgress | null = null;
  const showUpdate = async (next: UpdateProgress) => {
    progress = next;
    if (page) return;
    await stop();
    const statusPage = createStatusServer({
      cert: cert.certPem,
      key: cert.keyPem,
      readProgress: () => Promise.resolve(progress),
      // Several screens in one test run ask often; the limit itself is tested on its own.
      perMinute: 10_000,
    });
    await new Promise<void>((resolve) => statusPage.listen(port, '127.0.0.1', resolve));
    page = statusPage;
  };
  const endUpdate = async () => {
    const current = page;
    page = null;
    if (!current) return;
    current.closeAllConnections();
    await new Promise<void>((resolve) => current.close(() => resolve()));
  };
  await start();
  return {
    showUpdate,
    endUpdate,
    get url() {
      return `https://localhost:${port}`;
    },
    get port() {
      return port;
    },
    ca,
    stop,
    start,
    close: stop,
  };
}

/**
 * A user with the owner role and a real 2-step secret, so a test can type the current code
 * (the base32 secret is returned for that). Created as already set up.
 */
export async function addOwnerWithTwoStep(
  server: TestServer,
  options: Omit<UserOptions, 'method' | 'roles'> & {
    roles?: string[];
    /** Recovery codes to store (as Argon2id hashes), as the 2-step setup would. */
    recoveryCodes?: string[];
  },
): Promise<{ id: bigint; secret: string }> {
  const { recoveryCodes = [], ...user } = options;
  const id = await addUser(server, {
    ...user,
    method: 'password_totp',
    roles: user.roles ?? ['owner'],
  });
  const secret = newTotpSecret();
  const hashes = await Promise.all(
    recoveryCodes.map((c) => server.deps.hasher.hash(normalizeCode(c))),
  );
  await withBusinessTx(
    server.db,
    { userId: id, requestId: randomUUID(), reason: 'test fixture' },
    async (trx) => {
      await trx
        .updateTable('auth.users')
        .set({
          totp_secret_enc: server.deps.secretBox.seal(
            Buffer.from(secret, 'utf8'),
            `auth.users.totp_secret_enc:${id}`,
          ),
          totp_enabled: true,
        })
        .where('id', '=', id)
        .execute();
      for (const code_hash of hashes) {
        await trx
          .insertInto('auth.recovery_codes')
          .values({ user_id: id, code_hash } as never)
          .execute();
      }
    },
  );
  return { id, secret };
}
