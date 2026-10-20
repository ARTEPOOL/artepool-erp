/**
 * The packaged server (`pnpm build:server`, decision 0103), run the way the installed server PC
 * runs it: from a folder outside the repository, with the settings file and only the secrets the
 * launcher gives. It upgrades an empty database, refuses a common password and creates the owner
 * (the bundled password list and the native Argon2 library), and answers /health over TLS 1.3.
 * Without the settings file or the master key it refuses to start, and it never reads a `.env`.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { createServer, type AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsDir, requireEnv } from '@artepool/node-kit';
import { createEmptyTestDatabase, type TestDatabase } from '@artepool/testing';
import { TLS_FILES, createCa, issueServerCert, writeTlsFile } from '@artepool/tls';
import { ENTRY_POINTS, buildServer, type Manifest } from '../../src/build';

let root: string;
let outDir: string;
let dataDir: string;
let configFile: string;
let db: TestDatabase;
let manifest: Manifest;
let caCertPem: string;
let port: number;
const masterKey = randomBytes(32).toString('base64');

interface Run {
  code: number | null;
  out: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as AddressInfo;
      probe.close(() => resolve(free));
    });
  });
}

/** The environment the launcher gives: the settings file and the secrets, nothing else. */
function launcherEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    ARTEPOOL_CONFIG: configFile,
    ARTEPOOL_MASTER_KEY: masterKey,
    ARTEPOOL_MIGRATOR_PASSWORD: requireEnv('ARTEPOOL_MIGRATOR_PASSWORD'),
    ARTEPOOL_API_PASSWORD: requireEnv('ARTEPOOL_API_PASSWORD'),
    ARTEPOOL_BACKUP_PASSWORD: requireEnv('ARTEPOOL_BACKUP_PASSWORD'),
    ARTEPOOL_MAINT_PASSWORD: requireEnv('ARTEPOOL_MAINT_PASSWORD'),
    ...extra,
  };
}

/** Runs one of the bundled programs to the end, from a folder with a decoy `.env`. */
function run(program: string, args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(outDir, `${program}.mjs`), ...args], {
      cwd: root,
      env,
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

function health(): Promise<{ protocol: string; body: { status: string; schemaVersion: number } }> {
  return new Promise((resolve, reject) => {
    const request = get(
      { host: '127.0.0.1', port, path: '/health', ca: caCertPem, servername: 'localhost' },
      (response) => {
        const protocol = (response.socket as TLSSocket).getProtocol() ?? '';
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () =>
          resolve({
            protocol,
            body: JSON.parse(body) as { status: string; schemaVersion: number },
          }),
        );
      },
    );
    request.on('error', reject);
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'artepool-bundle-'));
  outDir = join(root, 'Program Files', 'ARTEPOOL', 'server');
  dataDir = join(root, 'ProgramData', 'ARTEPOOL');
  // A decoy: if the bundle ever read a .env, it would get a wrong database and fail.
  await writeFile(join(root, '.env'), 'ARTEPOOL_DB=wrong_db\nPGPORT=1\n');
  [manifest, db] = await Promise.all([buildServer({ outDir }), createEmptyTestDatabase()]);

  const ca = await createCa({ dns: ['localhost'], ips: ['127.0.0.1'] });
  const cert = await issueServerCert(ca, { dns: ['localhost'], ips: ['127.0.0.1'] });
  caCertPem = ca.certPem;
  const tls = join(dataDir, 'secrets', 'tls');
  await writeTlsFile(tls, TLS_FILES.caCert, ca.certPem);
  await writeTlsFile(tls, TLS_FILES.serverCert, cert.certPem);
  await writeTlsFile(tls, TLS_FILES.serverKey, cert.keyPem);

  port = await freePort();
  configFile = join(dataDir, 'config', 'server.json');
  await mkdir(join(dataDir, 'config'), { recursive: true });
  await writeFile(
    configFile,
    JSON.stringify({
      version: 1,
      dataDir,
      server: { host: '127.0.0.1', port },
      database: {
        host: process.env.PGHOST || 'localhost',
        port: Number(process.env.PGPORT || 5432),
        name: db.name,
      },
      pgBin: join(root, 'pgsql', 'bin'),
      logLevel: 'warn',
    }),
  );
}, 120_000);

afterAll(async () => {
  await db?.drop();
  await rm(root, { recursive: true, force: true });
});

describe('the packaged server', () => {
  it('holds the programs, the resources and a manifest of every file', async () => {
    for (const name of Object.keys(ENTRY_POINTS)) {
      expect(manifest.files[`${name}.mjs`], name).toMatch(/^[0-9a-f]{64}$/);
    }
    const paths = Object.keys(manifest.files);
    expect(paths.some((p) => p.startsWith('node_modules/@node-rs/argon2/'))).toBe(true);
    expect(paths).toContain('resources/apps/server/src/platform/auth/common-passwords.txt');
    const migrations = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
    for (const file of migrations) expect(paths).toContain(`resources/db/migrations/${file}`);
    // No source code, no settings, no secrets.
    expect(paths.filter((p) => /\.ts$|(^|\/)\.env|\.key$/.test(p))).toEqual([]);
    // The manifest matches the files.
    for (const file of [
      'server.mjs',
      'resources/db/migrations/0001_extensions_schemas_helpers.sql',
    ]) {
      const actual = createHash('sha256')
        .update(await readFile(join(outDir, file)))
        .digest('hex');
      expect(manifest.files[file], file).toBe(actual);
    }
  });

  it('refuses to start without the settings file (and never falls back to a .env)', async () => {
    const result = await run('server', [], { PATH: process.env.PATH });
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('The settings file was not given (ARTEPOOL_CONFIG)');
  });

  it('refuses to start without the master key from the launcher', async () => {
    const env = launcherEnv();
    delete env.ARTEPOOL_MASTER_KEY;
    const result = await run('server', [], env);
    expect(result.code).not.toBe(0);
    expect(result.out).toContain('The master key was not given');
  });

  it('upgrades an empty database with the bundled migrations', async () => {
    const up = await run('migrate', ['up'], launcherEnv());
    expect(up.out).toMatch(/Database upgraded: \d+ migration\(s\) applied/);
    expect(up.code).toBe(0);
    const status = await run('migrate', ['status'], launcherEnv());
    expect(status.out).toContain('Pending: 0.');
  });

  it('refuses a common password (bundled list), then creates the owner (native Argon2)', async () => {
    const answers = (password: string) =>
      ['mohammed', 'محمد', 'Mohammed', password, password, ''].join('\n');
    const common = await run('owner-create', [], launcherEnv(), answers('1234567890'));
    expect(common.out).toContain('This password is too common');
    expect(common.code).toBe(1);
    const created = await run('owner-create', [], launcherEnv(), answers('blue-pool-water-71'));
    expect(created.out).toContain('Owner "mohammed" created');
    expect(created.code).toBe(0);
  });

  it('answers /health over TLS 1.3 with the database upgraded', async () => {
    const child = spawn(process.execPath, [join(outDir, 'server.mjs')], {
      cwd: root,
      env: launcherEnv(),
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    try {
      let answer: Awaited<ReturnType<typeof health>> | undefined;
      for (let attempt = 0; attempt < 100 && !answer && child.exitCode === null; attempt++) {
        answer = await health().catch(() => undefined);
        if (!answer) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(answer, out).toBeDefined();
      const migrations = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
      expect(answer!.protocol).toBe('TLSv1.3');
      expect(answer!.body).toMatchObject({ status: 'ok', schemaVersion: migrations.length });
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
  });
});
