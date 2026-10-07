/**
 * HTTPS to the Main Server, the way the Windows app connects (architecture §6):
 * TLS 1.3 only, trusting only the pinned ARTÉPOOL CA, and checking the server's name.
 */
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { X509Certificate } from 'node:crypto';

export interface HttpAnswer {
  status: number;
  contentType: string;
  body: Buffer;
  /** The certificate the server presented (used to confirm the enrollment hello afterwards). */
  peerCertificate: X509Certificate | undefined;
}

export class ConnectionError extends Error {
  override readonly name = 'ConnectionError';
  constructor(
    readonly kind: 'unreachable' | 'untrusted',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const UNTRUSTED = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'UNSPECIFIED', // e.g. a name-constraint violation (permitted subtree)
]);

export interface SendOptions {
  method: string;
  headers?: Record<string, string>;
  body?: Buffer;
  /**
   * The pinned ARTÉPOOL CA. `null` only for the enrollment hello, before the PC knows the CA:
   * that answer is then checked with the code's proof and the presented certificate.
   */
  ca: string | null;
  timeoutMs?: number;
}

export function send(url: URL, options: SendOptions): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const request = httpsRequest(
      {
        protocol: 'https:',
        host,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: options.headers,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        ...(isIP(host) ? {} : { servername: host }),
        ...(options.ca === null ? { rejectUnauthorized: false } : { ca: options.ca }),
        agent: false,
        timeout: options.timeoutMs ?? 15_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        const socket = response.socket as TLSSocket;
        const peerCertificate = socket.getPeerX509Certificate?.();
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks),
            peerCertificate,
          }),
        );
        response.on('error', (error) =>
          reject(new ConnectionError('unreachable', error.message, { cause: error })),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error: NodeJS.ErrnoException) => {
      const kind = error.code && UNTRUSTED.has(error.code) ? 'untrusted' : 'unreachable';
      reject(new ConnectionError(kind, error.message, { cause: error }));
    });
    request.end(options.body);
  });
}

/**
 * After the enrollment proof has shown that `caPem` is genuine: was the hello answered by a
 * server whose certificate that CA issued, for this name? Then the hello is trusted too.
 */
export function issuedFor(peer: X509Certificate | undefined, caPem: string, url: URL): boolean {
  if (!peer) return false;
  const ca = new X509Certificate(caPem);
  if (!peer.checkIssued(ca) || !peer.verify(ca.publicKey)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return isIP(host) ? peer.checkIP(host) !== undefined : peer.checkHost(host) !== undefined;
}
