// CI (M6.2 part F): /health over TLS 1.3, trusting only the installation's ARTEPOOL CA.
// Usage: tsx health.ts <ca.crt> <port>
import { readFileSync } from 'node:fs';
import { get } from 'node:https';
import type { TLSSocket } from 'node:tls';

interface Answer {
  status?: number;
  protocol?: string;
  body?: string;
  error?: string;
}

const [caFile, port] = process.argv.slice(2);
if (!caFile || !port) throw new Error('Usage: health <ca.crt> <port>');
const ca = readFileSync(caFile, 'utf8');
for (let attempt = 1; attempt <= 60; attempt++) {
  const result = await new Promise<Answer>((resolve) => {
    const request = get(
      {
        host: '127.0.0.1',
        port: Number(port),
        path: '/health',
        ca,
        servername: 'localhost',
        timeout: 3000,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            protocol: (response.socket as TLSSocket).getProtocol() ?? '',
            body,
          }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error: Error) => resolve({ error: error.message }));
  });
  if (result.status === 200) {
    if (result.protocol !== 'TLSv1.3') {
      console.error(`health answered over ${result.protocol}, not TLSv1.3`);
      process.exit(1);
    }
    console.log(`ok - /health over ${result.protocol}: ${result.body}`);
    process.exit(0);
  }
  if (attempt === 60) {
    console.error(`health did not answer: ${JSON.stringify(result)}`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
