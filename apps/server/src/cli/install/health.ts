/** /health over TLS 1.3, trusting only the ARTEPOOL CA; up to two minutes (install, upgrade). */
import { get } from 'node:https';
import type { TLSSocket } from 'node:tls';

export function waitHealthy(port: number, onTimeout: () => Error) {
  return async (ca: string): Promise<void> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const ok = await new Promise<boolean>((resolve) => {
        const request = get(
          { host: '127.0.0.1', port, path: '/health', ca, servername: 'localhost', timeout: 3000 },
          (response) => {
            const tls13 = (response.socket as TLSSocket).getProtocol() === 'TLSv1.3';
            response.resume();
            resolve(tls13 && response.statusCode === 200);
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
