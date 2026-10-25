/**
 * The server PC's installation (M6.2 part F) from start to finish, with a fake Windows (folder
 * rules, services and the firewall are recorded) and a fake initdb, against the real test
 * PostgreSQL: the folders, the database settings, the roles, a new database with every migration,
 * the ARTÉPOOL CA and server certificate, the setup token and CA for the wizard, the services in
 * the right order, the firewall rule; the superuser's password file is gone and the log holds no
 * secret. An earlier installation, an old Windows or a busy port stop it before anything changes.
 */
import { X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionFor, migrationsDir } from '@artepool/node-kit';
import { InstallLog } from '../../src/cli/install/log';
import { InstallError, runInstall, type InstallPaths } from '../../src/cli/install/steps';
import type { Platform } from '../../src/cli/install/windows';

let root: string;
const database = `artepool_install_${process.pid}_test`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function pathsIn(dir: string): InstallPaths {
  return {
    dataDir: dir,
    pgBin: join(dir, 'pgsql', 'bin'),
    pgdata: join(dir, 'pgdata'),
    wal: join(dir, 'wal'),
    backups: join(dir, 'backups'),
    logs: join(dir, 'logs'),
    secrets: join(dir, 'secrets'),
    config: join(dir, 'config'),
    setup: join(dir, 'setup'),
    tls: join(dir, 'secrets', 'tls'),
    tokenFile: join(dir, 'setup', 'token'),
  };
}

function fakePlatform() {
  const calls: string[] = [];
  const platform: Platform = {
    restrictFolder: (folder, grants = []) =>
      Promise.resolve(void calls.push(`restrict ${folder} ${grants.length}`)),
    grantFolder: (folder, grant) =>
      Promise.resolve(void calls.push(`grant ${folder} ${grant.service}:${grant.access}`)),
    startDatabaseService: (pgdata) => Promise.resolve(void calls.push(`database ${pgdata}`)),
    registerAppService: (service) => Promise.resolve(void calls.push(`register ${service}`)),
    startService: (service) => Promise.resolve(void calls.push(`start ${service}`)),
    addFirewallRule: (port) => Promise.resolve(void calls.push(`firewall ${port}`)),
  };
  return { platform, calls };
}

/** initdb as far as the installation sees it: the two settings files in the data folder. */
function fakeInitdb(seen: { passwordFile?: string; password?: string }) {
  return async (file: string, args: string[]) => {
    if (!file.endsWith('initdb')) throw new Error(`unexpected ${file}`);
    const pgdata = args[args.indexOf('-D') + 1]!;
    const pwfile = args.find((a) => a.startsWith('--pwfile='))!.slice('--pwfile='.length);
    seen.passwordFile = pwfile;
    seen.password = (await readFile(pwfile, 'utf8')).trim();
    await mkdir(pgdata, { recursive: true });
    await writeFile(join(pgdata, 'postgresql.conf'), "#listen_addresses = 'localhost'\n");
    await writeFile(join(pgdata, 'pg_hba.conf'), 'host all all all trust\n');
    return 'Success. You can now start the database server.\n';
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'artepool-install-'));
});

afterAll(async () => {
  const admin = new pg.Client({ ...connectionFor('superuser'), database: 'postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(database)} WITH (FORCE)`);
  await admin.end();
  await rm(root, { recursive: true, force: true });
});

describe('the server installation', () => {
  it('installs everything in order, and the log holds no secret', async () => {
    const dir = join(root, 'pc1');
    const paths = pathsIn(dir);
    const { platform, calls } = fakePlatform();
    const seen: { passwordFile?: string; password?: string } = {};
    const lines: string[] = [];
    const logFile = join(paths.logs, 'install', 'install-test.log');
    const log = new InstallLog(logFile, (l) => lines.push(l));
    let healthCa = '';
    const [serverPort, databasePort] = [await freePort(), await freePort()];

    await runInstall({
      paths,
      serverPort,
      databasePort,
      databaseName: database,
      platform,
      exec: fakeInitdb(seen),
      log,
      windowsBuild: null,
      allowNonWindows: true,
      names: { dns: ['artepool-server', 'localhost'], ips: ['127.0.0.1', '192.168.1.10'] },
      waitHealthy: (ca) => Promise.resolve(void (healthCa = ca)),
    });

    // The order: folders closed first, the database service, then the app services and firewall.
    expect(calls.indexOf(`restrict ${paths.pgdata} 0`)).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf(`database ${paths.pgdata}`)).toBeLessThan(
      calls.indexOf('register server'),
    );
    expect(calls.slice(-5)).toEqual([
      `grant ${paths.wal} backup:read`,
      `grant ${paths.setup} server:modify`,
      'start server',
      'start backup',
      `firewall ${serverPort}`,
    ]);
    expect(calls).toContain(`grant ${join(paths.secrets, 'backup')} server:modify`);
    expect(calls.filter((c) => c.includes('Users') || c.includes('Everyone'))).toEqual([]);

    // PostgreSQL: the superuser's password came from the launcher, through a file now gone.
    expect(seen.password).toBe(process.env.PG_SUPERUSER_PASSWORD);
    expect(existsSync(seen.passwordFile!)).toBe(false);
    expect(await readdir(paths.setup)).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/initdb/)]),
    );
    const conf = await readFile(join(paths.pgdata, 'postgresql.conf'), 'utf8');
    expect(conf).toContain(`port = ${databasePort}`);
    expect(conf).toContain('archive_mode = on');
    expect(await readFile(join(paths.pgdata, 'pg_hba.conf'), 'utf8')).not.toContain('trust');

    // The database with every migration, owned by the ARTÉPOOL owner role.
    const migrator = new pg.Client(connectionFor('migrator', database));
    await migrator.connect();
    const { rows } = await migrator.query<{ n: string; owner: string }>(
      `SELECT (SELECT count(*) FROM sys.schema_migrations)::text AS n,
              (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS owner`,
    );
    await migrator.end();
    const migrations = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
    expect(rows[0]).toEqual({ n: String(migrations.length), owner: 'artepool_owner' });

    // The certificates: the server certificate names this PC and is signed by the new CA; the
    // wizard's copy of the CA and the one-time token.
    const caPem = await readFile(join(paths.tls, 'ca.crt'), 'utf8');
    const server = new X509Certificate(await readFile(join(paths.tls, 'server.crt'), 'utf8'));
    expect(server.verify(new X509Certificate(caPem).publicKey)).toBe(true);
    expect(server.subjectAltName).toContain('DNS:artepool-server');
    expect(server.subjectAltName).toContain('IP Address:192.168.1.10');
    expect(await readFile(join(paths.setup, 'ca.crt'), 'utf8')).toBe(caPem);
    expect(healthCa).toBe(caPem);
    const token = (await readFile(paths.tokenFile, 'utf8')).trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The log: every step, no secret.
    const written = await readFile(logFile, 'utf8');
    for (let n = 1; n <= 9; n++) expect(written).toContain(`Step ${n}/9`);
    for (const secret of [
      token,
      process.env.PG_SUPERUSER_PASSWORD!,
      process.env.ARTEPOOL_API_PASSWORD!,
      process.env.ARTEPOOL_MIGRATOR_PASSWORD!,
    ].filter((s) => s.length >= 4)) {
      expect(written).not.toContain(secret);
      expect(lines.join('\n')).not.toContain(secret);
    }
  }, 120_000);

  it('refuses an earlier installation, an old Windows and a busy port, changing nothing', async () => {
    const run = (dir: string, patch: Partial<Parameters<typeof runInstall>[0]>) =>
      runInstall({
        paths: pathsIn(dir),
        serverPort: 1,
        databasePort: 1,
        databaseName: `artepool_never_${process.pid}_test`,
        platform: fakePlatform().platform,
        exec: () => Promise.reject(new Error('nothing may run')),
        log: new InstallLog(null, () => undefined),
        windowsBuild: 26100,
        waitHealthy: () => Promise.resolve(),
        ...patch,
      });

    const installed = join(root, 'installed');
    await mkdir(join(installed, 'pgdata'), { recursive: true });
    await writeFile(join(installed, 'pgdata', 'PG_VERSION'), '18\n');
    await expect(run(installed, {})).rejects.toThrow(/already installed/);

    await expect(run(join(root, 'old'), { windowsBuild: 17763 })).rejects.toThrow(InstallError);
    await expect(run(join(root, 'linux'), { windowsBuild: null })).rejects.toThrow(/Windows 10/);

    const busy = createServer().listen(0, '0.0.0.0');
    await new Promise((resolve) => busy.once('listening', resolve));
    const port = (busy.address() as AddressInfo).port;
    try {
      await expect(
        run(join(root, 'busy'), { serverPort: port, databasePort: await freePort() }),
      ).rejects.toThrow(`Port ${port}`);
    } finally {
      busy.close();
    }
    expect(existsSync(join(root, 'busy', 'pgdata'))).toBe(false);
  });
});
