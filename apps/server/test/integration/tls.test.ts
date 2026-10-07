/**
 * T7: the API speaks HTTPS with TLS 1.3 only, with a certificate from the ARTÉPOOL CA, and that
 * CA cannot vouch for any other name (architecture §6).
 */
import { get } from 'node:https';
import { connect, createServer, type ConnectionOptions } from 'node:tls';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCa, issueServerCert, type PemPair } from '@artepool/tls';
import { buildApp } from '../../src/app';
import { startTestServer, type TestServer } from '../support/server';

let server: TestServer;
let ca: PemPair;
let app: FastifyInstance;
let port: number;

beforeAll(async () => {
  server = await startTestServer();
  ca = await createCa({ dns: ['localhost'], ips: ['127.0.0.1'] });
  const cert = await issueServerCert(ca, { dns: ['localhost'], ips: ['127.0.0.1'] });
  app = buildApp(
    { logLevel: 'silent', https: { cert: cert.certPem, key: cert.keyPem } },
    server.deps,
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await app.close();
  await server.close();
});

/** Opens a TLS connection and reports the protocol, or the error. */
function handshake(
  options: ConnectionOptions,
): Promise<{ protocol?: string | null; error?: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, servername: 'localhost', ...options }, () => {
      resolve({ protocol: socket.getProtocol() });
      socket.end();
    });
    socket.on('error', (error: NodeJS.ErrnoException) =>
      resolve({ error: error.code ?? error.message }),
    );
  });
}

describe('HTTPS', () => {
  it('serves the API over TLS 1.3 to a client that trusts the ARTÉPOOL CA', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      get(
        { host: '127.0.0.1', port, path: '/health', ca: ca.certPem, servername: 'localhost' },
        (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          res.on('end', () => resolve(text));
        },
      ).on('error', reject);
    });
    expect(JSON.parse(body)).toMatchObject({ status: 'ok' });
    expect(await handshake({ ca: ca.certPem })).toEqual({ protocol: 'TLSv1.3' });
  });

  it('refuses TLS 1.2 and older', async () => {
    const result = await handshake({ ca: ca.certPem, maxVersion: 'TLSv1.2' });
    expect(result.error).toBeDefined();
  });

  it('is not trusted by a client that does not know the ARTÉPOOL CA', async () => {
    const result = await handshake({});
    expect(result.error).toMatch(/SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY/);
  });

  it('cannot be used for a name the CA was not created for', async () => {
    // Even with the CA key, a certificate for another name is refused by clients; the same
    // path with a permitted name works, so the refusal comes from the name constraints.
    const attempt = async (name: string) => {
      const cert = await issueServerCert(ca, { dns: [name], ips: [] }, 30, {
        skipConstraintCheck: true,
      });
      const tlsServer = createServer({
        cert: cert.certPem,
        key: cert.keyPem,
        minVersion: 'TLSv1.3',
      });
      await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
      const otherPort = (tlsServer.address() as AddressInfo).port;
      const result = await new Promise<string>((resolve) => {
        const socket = connect(
          { host: '127.0.0.1', port: otherPort, servername: name, ca: ca.certPem },
          () => {
            resolve('trusted');
            socket.end();
          },
        );
        socket.on('error', (error: Error) => resolve(error.message));
      });
      tlsServer.close();
      return result;
    };
    expect(await attempt('localhost')).toBe('trusted');
    expect(await attempt('evil.example')).toBe('permitted subtree violation');
  });
});
