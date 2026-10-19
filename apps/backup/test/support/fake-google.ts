/** A stand-in for Google's sign-in and Drive endpoints, in memory, for the tests. */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GoogleEndpoints } from '../../src/config';

export interface FakeFile {
  id: string;
  name: string;
  body: Buffer;
  trashed: boolean;
}

export interface FakeGoogle {
  endpoints: GoogleEndpoints;
  files: FakeFile[];
  /** The device sign-in waits until this is true. */
  approve(): void;
  close(): Promise<void>;
}

const read = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
  });

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const files: FakeFile[] = [];
  const uploads = new Map<string, string>();
  let approved = false;
  let next = 1;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://fake');
      const body = await read(req);
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(value));
      };
      const fields = new URLSearchParams(body.toString());
      if (url.pathname === '/oauth/device/code') {
        return json(200, {
          device_code: 'dev-123',
          user_code: 'ABCD-EFGH',
          verification_url: 'https://www.google.com/device',
          expires_in: 1800,
          interval: 5,
        });
      }
      if (url.pathname === '/oauth/token') {
        if (fields.get('grant_type') === 'refresh_token') {
          return fields.get('refresh_token') === 'refresh-xyz'
            ? json(200, { access_token: 'access-1' })
            : json(400, { error: 'invalid_grant' });
        }
        return approved
          ? json(200, { refresh_token: 'refresh-xyz', access_token: 'access-1' })
          : json(428, { error: 'authorization_pending' });
      }
      if (req.headers.authorization !== 'Bearer access-1')
        return json(401, { error: 'unauthorized' });
      if (url.pathname === '/upload/files' && req.method === 'POST') {
        const meta = JSON.parse(body.toString()) as { name: string };
        const session = `s${next++}`;
        uploads.set(session, meta.name);
        const port = (server.address() as AddressInfo).port;
        return json(200, {}, { location: `http://127.0.0.1:${port}/upload/session/${session}` });
      }
      if (url.pathname.startsWith('/upload/session/') && req.method === 'PUT') {
        const name = uploads.get(url.pathname.split('/').pop()!)!;
        const file = { id: `f${next++}`, name, body, trashed: false };
        files.push(file);
        return json(200, { id: file.id, name });
      }
      if (url.pathname === '/drive/files' && req.method === 'GET') {
        return json(200, {
          files: files.filter((f) => !f.trashed).map(({ id, name }) => ({ id, name })),
        });
      }
      if (url.pathname.startsWith('/drive/files/') && req.method === 'PATCH') {
        const file = files.find((f) => f.id === url.pathname.split('/').pop());
        if (file) file.trashed = true;
        return json(200, {});
      }
      return json(404, { error: 'not_found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoints: { oauth: `${base}/oauth`, api: `${base}/drive`, upload: `${base}/upload` },
    files,
    approve: () => {
      approved = true;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
