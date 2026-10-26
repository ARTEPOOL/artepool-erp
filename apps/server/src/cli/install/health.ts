/** /health over TLS 1.3, trusting only the ARTEPOOL CA; up to two minutes (install, upgrade, renewal). */
import { X509Certificate } from 'node:crypto';
import { get } from 'node:https';
import type { TLSSocket } from 'node:tls';

export function waitHealthy(port: number, onTimeout: () => Error) {
  /** With `servedCertPem`, also checks the server uses that certificate (a renewal, part H3). */
  return async (ca: string, servedCertPem?: string): Promise<void> => {
    const expected = servedCertPem ? new X509Certificate(servedCertPem).fingerprint256 : null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const ok = await new Promise<boolean>((resolve) => {
        const request = get(
          { host: '127.0.0.1', port, path: '/health', ca, servername: 'localhost', timeout: 3000 },
          (response) => {
            const socket = response.socket as TLSSocket;
            const tls13 = socket.getProtocol() === 'TLSv1.3';
            const served =
              expected === null || socket.getPeerCertificate().fingerprint256 === expected;
            response.resume();
            resolve(tls13 && served && response.statusCode === 200);
          },
        );
        request.on('timeout', () => request.destroy());
        request.on('error', () => resolve(false));
      });
      if (ok) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw onTimeout();
  };
}
