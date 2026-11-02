/**
 * The status page while the server is stopped for an update (decision 0115, 0.9.0), over a real
 * TLS connection with a test ARTÉPOOL CA:
 * - `GET /health` gives the versions and the steps only (never the reason text: it could hold
 *   data), with 503 "updating";
 * - every other request is refused, and one address asking too often is limited;
 * - TLS 1.3 only, with the server's own certificate;
 * - starting it never stops an update; stopping it is waited for, and its process is ended as a
 *   last resort, because the server needs the port back; its record keeps its start and stop.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCa, issueServerCert, type PemPair } from '@artepool/tls';
import {
  beginProgress,
  finishProgress,
  startStep,
  writeProgress,
} from '../../src/cli/upgrade/progress';
import {
  readStatusPageRecord,
  statusPageControl,
  statusPageFiles,
  writeStatusPageRecord,
} from '../../src/cli/upgrade/status-page-control';
import { createStatusServer, type StatusAnswer } from '../../src/cli/upgrade/status-server';

let ca: PemPair;
let cert: PemPair;
let dir: string;

beforeAll(async () => {
  const names = { dns: ['localhost'], ips: ['127.0.0.1'] };
  ca = await createCa(names);
  cert = await issueServerCert(ca, names);
  dir = await mkdtemp(join(tmpdir(), 'artepool-status-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

interface Answer {
  status: number;
  body: Record<string, unknown>;
  protocol: string;
}

function ask(port: number, method: string, path: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port, method, path, ca: ca.certPem, servername: 'localhost' },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString()));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(text) as Record<string, unknown>,
            protocol: (res.socket as TLSSocket).getProtocol() ?? '',
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(method === 'POST' ? '{"username":"owner"}' : undefined);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('the status page (0115)', () => {
  it('answers /health with the versions and the steps only, as "updating"', async () => {
    const file = join(dir, 'progress.json');
    const at = new Date('2026-11-05T23:00:00Z');
    let progress = startStep(beginProgress('0.9.0', '0.9.1', at), 'backup', at);
    await writeProgress(file, progress);
    const answers: StatusAnswer[] = [];
    const server = createStatusServer({
      cert: cert.certPem,
      key: cert.keyPem,
      readProgress: async () => (await import('../../src/cli/upgrade/progress')).readProgress(file),
      onAnswer: (a) => answers.push(a),
    });
    const port = await listen(server);
    try {
      const health = await ask(port, 'GET', '/health');
      expect(health.status).toBe(503);
      expect(health.protocol).toBe('TLSv1.3');
      expect(health.body).toEqual({
        status: 'updating',
        update: {
          from: '0.9.0',
          to: '0.9.1',
          startedAt: at.toISOString(),
          steps: progress.steps,
          result: null,
        },
      });

      // A failure: whether it worked and where it stopped, never the reason text.
      progress = finishProgress(progress, at, {
        ok: false,
        step: 'database',
        detail: 'Key (phone)=(0501234567) already exists.',
      });
      await writeProgress(file, progress);
      const failed = await ask(port, 'GET', '/health?x=1');
      expect(failed.body.update).toMatchObject({
        result: { ok: false, at: at.toISOString(), step: 'database' },
      });
      expect(JSON.stringify(failed.body)).not.toContain('0501234567');

      // Everything else is refused, whatever it is.
      for (const [method, path] of [
        ['POST', '/api/v1/auth/sign-in'],
        ['GET', '/api/v1/system/updates'],
        ['GET', '/'],
        ['PUT', '/health'],
      ] as const) {
        const refused = await ask(port, method, path);
        expect(refused.status, `${method} ${path}`).toBe(503);
        expect(refused.body).toEqual({
          error: { code: 'UPDATING', message: 'ARTEPOOL is being updated.' },
        });
      }
      expect(answers).toEqual(['status', 'status', 'refused', 'refused', 'refused', 'refused']);
    } finally {
      server.close();
    }
  });

  it('limits one address that asks too often', async () => {
    let now = 0;
    const server = createStatusServer({
      cert: cert.certPem,
      key: cert.keyPem,
      readProgress: () => Promise.resolve(null),
      perMinute: 3,
      clock: () => now,
    });
    const port = await listen(server);
    try {
      for (let i = 0; i < 3; i++) expect((await ask(port, 'GET', '/health')).status).toBe(503);
      const limited = await ask(port, 'GET', '/health');
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ error: { code: 'TOO_MANY_REQUESTS' } });
      // A minute later it may ask again.
      now += 60_000;
      expect((await ask(port, 'GET', '/health')).body).toEqual({
        status: 'updating',
        update: null,
      });
    } finally {
      server.close();
    }
  });

  it('speaks TLS 1.3 only', async () => {
    const server = createStatusServer({
      cert: cert.certPem,
      key: cert.keyPem,
      readProgress: () => Promise.resolve(null),
    });
    const port = await listen(server);
    try {
      const outcome = await new Promise<string>((resolve) => {
        const socket = tlsConnect({
          host: '127.0.0.1',
          port,
          ca: ca.certPem,
          servername: 'localhost',
          maxVersion: 'TLSv1.2',
        });
        socket.on('secureConnect', () => {
          resolve('connected');
          socket.destroy();
        });
        socket.on('error', () => resolve('refused'));
      });
      expect(outcome).toBe('refused');
    } finally {
      server.close();
    }
  });
});

describe('starting and stopping the status page (0115)', () => {
  /** Plays the page: writes its record as the real one does, and stops when asked. */
  function fakePage(updatesDir: string, behaviour: 'answers' | 'fails' | 'ignores' = 'answers') {
    const files = statusPageFiles(updatesDir);
    const calls: string[][] = [];
    const spawned: { pid: number }[] = [];
    return {
      calls,
      spawned,
      spawn: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        // A real process for the "ignores" case, so ending it can be checked.
        const child =
          behaviour === 'ignores'
            ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
            : null;
        const pid = child?.pid ?? 4242;
        spawned.push({ pid });
        const record = {
          pid,
          startedAt: behaviour === 'fails' ? null : new Date().toISOString(),
          stoppedAt: behaviour === 'fails' ? new Date().toISOString() : null,
          stopReason: behaviour === 'fails' ? 'error' : null,
          answers: { status: 0, refused: 0, limited: 0 },
          error: behaviour === 'fails' ? 'EACCES' : null,
        };
        void writeStatusPageRecord(files.record, record);
        if (behaviour === 'answers') {
          const timer = setInterval(() => {
            if (existsSync(files.stop)) {
              clearInterval(timer);
              void writeStatusPageRecord(files.record, {
                ...record,
                stoppedAt: new Date().toISOString(),
                stopReason: 'asked',
                answers: { status: 12, refused: 1, limited: 0 },
              });
            }
          }, 50);
        }
      },
    };
  }

  async function control(name: string, behaviour?: 'answers' | 'fails' | 'ignores') {
    const updatesDir = join(dir, name);
    const programs = join(dir, `${name}-programs`);
    await import('node:fs/promises').then((fs) => fs.mkdir(programs, { recursive: true }));
    await import('node:fs/promises').then((fs) => fs.mkdir(updatesDir, { recursive: true }));
    await writeFile(join(programs, 'node.exe'), 'MZ node');
    await writeFile(join(programs, 'status-page.mjs'), '// the page');
    const page = fakePage(updatesDir, behaviour);
    const lines: string[] = [];
    const ctl = statusPageControl({
      updatesDir,
      nodeExe: join(programs, 'node.exe'),
      script: join(programs, 'status-page.mjs'),
      host: '0.0.0.0',
      port: 3100,
      certFile: 'C:\\ProgramData\\ARTEPOOL\\secrets\\tls\\server.crt',
      keyFile: 'C:\\ProgramData\\ARTEPOOL\\secrets\\tls\\server.key',
      log: (line) => lines.push(line),
      spawn: page.spawn,
      waitMs: 2000,
    });
    return { ctl, page, lines, files: statusPageFiles(updatesDir), updatesDir };
  }

  it('runs a copy from the updates folder, and keeps its start and stop', async () => {
    const { ctl, page, lines, files, updatesDir } = await control('normal');
    await ctl.start();
    const [command, script, ...args] = page.calls[0]!;
    // Copies outside the program folders the setup swaps.
    expect(command).toBe(join(files.folder, 'node.exe'));
    expect(script).toBe(join(files.folder, 'status-page.mjs'));
    expect(await readFile(command!, 'utf8')).toBe('MZ node');
    expect(args).toEqual([
      '--host',
      '0.0.0.0',
      '--port',
      '3100',
      '--cert',
      'C:\\ProgramData\\ARTEPOOL\\secrets\\tls\\server.crt',
      '--key',
      'C:\\ProgramData\\ARTEPOOL\\secrets\\tls\\server.key',
      '--dir',
      updatesDir,
      '--minutes',
      '60',
    ]);
    expect(lines.at(-1)).toMatch(/answers on port 3100/);

    const record = await ctl.stop();
    expect(record).toMatchObject({ stopReason: 'asked', answers: { status: 12, refused: 1 } });
    expect(record?.startedAt).not.toBeNull();
    expect(record?.stoppedAt).not.toBeNull();
    expect(existsSync(files.stop)).toBe(false);
    // Stopping again changes nothing.
    expect(await ctl.stop()).toEqual(record);
  });

  it('a page that cannot start never stops the update', async () => {
    const { ctl, lines } = await control('fails', 'fails');
    await expect(ctl.start()).resolves.toBeUndefined();
    expect(lines.at(-1)).toMatch(/did not start \(EACCES\); the update goes on/);
  });

  it('a page that does not stop when asked is ended: the server needs the port', async () => {
    const { ctl, page, files } = await control('ignores', 'ignores');
    await ctl.start();
    const pid = page.spawned[0]!.pid;
    const record = await ctl.stop();
    expect(record).toMatchObject({ stopReason: 'ended' });
    expect(record?.stoppedAt).not.toBeNull();
    expect((await readStatusPageRecord(files.record))?.stopReason).toBe('ended');
    // Its process is gone.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('nothing to stop when it never started', async () => {
    const { ctl } = await control('never');
    expect(await ctl.stop()).toBeNull();
  });
});
