/**
 * The installation of the server PC (M6.2 part F), run once by the server setup through the
 * launcher (`artepool-svc run install`, as administrator, with the protected secrets):
 *
 *   1. checks          Windows 10 22H2 / 11, 64-bit; free space; ports free; no earlier installation
 *   2. folders         in ProgramData, each open only to SYSTEM, Administrators and its services
 *   3. database        initdb (the superuser's password from the protected store), settings
 *   4. database service  ArtepoolDatabase under its own account, started
 *   5. roles and data  the ARTÉPOOL roles, the empty database, the migrations
 *   6. certificates    the ARTÉPOOL CA and the server certificate; setup\ca.crt, setup\token
 *   7. services        ArtepoolServer and ArtepoolBackup under their own accounts, started
 *   8. firewall        the API port, local subnet, private networks
 *   9. ready           /health answers over TLS 1.3
 *
 * Every step is written to the install log (log.ts, secrets filtered). A failure stops at once with
 * its reason; nothing of the PC's other settings is touched.
 *
 * A reinstall over kept data (`reattach`, decision 0103, M6.2 part G3: the program was uninstalled,
 * the data in ProgramData stayed) uses the existing database, secrets, settings and certificates:
 * no initdb, no new database, no new CA (the PCs keep trusting it). A checked copy of the database
 * is made first, then its migrations are brought up to this version all or nothing; the first-run
 * setup opens again only if it was never finished.
 */
import { randomBytes } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname, networkInterfaces, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  createAppDatabase,
  databaseExists,
  ensureRoles,
  assertServerVersion,
} from '@artepool/dev-db';
import { migrate } from '@artepool/migrate';
import { preUpgradeCopy, reinstallCopyName } from '../upgrade/steps';
import { connectionFor, migrationsDir } from '@artepool/node-kit';
import { createCa, issueServerCert, TLS_FILES, writeTlsFile, type TlsNames } from '@artepool/tls';
import type { Exec } from '../restore-from-backup';
import type { InstallLog } from './log';
import { hbaConf, initdbArgs, postgresqlSettings } from './postgres';
import type { Platform } from './windows';

/** Windows 10 22H2 is build 19045. */
export const MINIMUM_WINDOWS_BUILD = 19045;
const MINIMUM_FREE_BYTES = 10 * 1024 ** 3;

export interface InstallPaths {
  dataDir: string;
  pgBin: string;
  pgdata: string;
  wal: string;
  backups: string;
  logs: string;
  secrets: string;
  config: string;
  setup: string;
  tls: string;
  tokenFile: string;
}

export interface InstallInput {
  paths: InstallPaths;
  serverPort: number;
  databasePort: number;
  databaseName: string;
  platform: Platform;
  exec: Exec;
  log: InstallLog;
  /** The PC's Windows build; null: not Windows (refused unless a test allows it). */
  windowsBuild: number | null;
  allowNonWindows?: boolean;
  /** Waits for /health over TLS 1.3 with the new CA; replaced in tests. */
  waitHealthy: (caPem: string) => Promise<void>;
  /** The PC's names for the certificate; default: its computer name and LAN addresses. */
  names?: TlsNames;
  /** Reinstall over the data an earlier installation left (part G3). */
  reattach?: boolean;
  now?: Date;
}

export class InstallError extends Error {
  override readonly name = 'InstallError';
}

export function windowsBuildOf(osRelease: string = release()): number | null {
  const match = /^10\.0\.(\d+)/.exec(osRelease);
  return match ? Number(match[1]) : null;
}

/** This PC's names: its computer name and localhost, its IPv4 LAN addresses and 127.0.0.1. */
export function pcNames(computer: string = hostname(), interfaces = networkInterfaces()): TlsNames {
  const dns = ['localhost'];
  const name = computer.toLowerCase();
  if (/^[a-z0-9]([a-z0-9-]{0,62})$/.test(name) && name !== 'localhost') dns.unshift(name);
  const ips = ['127.0.0.1'];
  for (const list of Object.values(interfaces)) {
    for (const address of list ?? []) {
      if (
        address.family === 'IPv4' &&
        !address.internal &&
        !address.address.startsWith('169.254.')
      ) {
        if (!ips.includes(address.address)) ips.push(address.address);
      }
    }
  }
  return { dns, ips };
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
      .once('error', () => resolve(false))
      .listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

/** initdb with the superuser's password, the folder closed, the settings written (new install). */
async function createDatabaseFolder(input: InstallInput, password: string): Promise<void> {
  const { paths, platform, exec, log } = input;
  // In a private folder of the installing administrator (initdb, without administrator rights,
  // must be able to read it), deleted at once.
  const passwordDir = await mkdtemp(join(tmpdir(), 'artepool-initdb-'));
  const passwordFile = join(passwordDir, 'pw');
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  try {
    const out = await exec(
      join(paths.pgBin, process.platform === 'win32' ? 'initdb.exe' : 'initdb'),
      initdbArgs(paths.pgdata, passwordFile),
    );
    log.line(out.trim().split('\n').slice(-2).join(' '));
  } finally {
    await rm(passwordDir, { recursive: true, force: true });
  }
  await platform.restrictFolder(paths.pgdata);
  await appendFile(
    join(paths.pgdata, 'postgresql.conf'),
    postgresqlSettings({ port: input.databasePort, walDir: paths.wal }),
  );
  await writeFile(join(paths.pgdata, 'pg_hba.conf'), hbaConf());
}

async function setupFinished(database: string): Promise<boolean> {
  const client = new pg.Client({ ...connectionFor('superuser'), database });
  await client.connect();
  try {
    const { rows } = await client.query<{ state: string }>('SELECT state FROM sys.setup_state');
    return rows[0]?.state === 'complete';
  } finally {
    await client.end();
  }
}

const TOTAL = 9;

export async function runInstall(input: InstallInput): Promise<void> {
  const { paths, platform, log } = input;
  const step = (n: number, title: string) => log.line(`Step ${n}/${TOTAL}: ${title}`);

  step(1, 'checks');
  if (input.windowsBuild === null && !input.allowNonWindows) {
    throw new InstallError('This installation runs on Windows 10 (22H2) or Windows 11 only.');
  }
  if (input.windowsBuild !== null && input.windowsBuild < MINIMUM_WINDOWS_BUILD) {
    throw new InstallError(
      `Windows build ${input.windowsBuild} is too old: Windows 10 22H2 (build ${MINIMUM_WINDOWS_BUILD}) or Windows 11 is needed.`,
    );
  }
  if (process.arch !== 'x64') throw new InstallError('A 64-bit Windows is needed.');
  const reattach = input.reattach === true;
  if (reattach) {
    if (!(await exists(join(paths.pgdata, 'PG_VERSION')))) {
      throw new InstallError(
        'There is no earlier ARTEPOOL data on this PC to use. Nothing was changed.',
      );
    }
    log.line('Reinstall: the data of the earlier installation is kept and used.');
  } else if (!(await isEmptyOrMissing(paths.pgdata))) {
    throw new InstallError(
      'ARTEPOOL is already installed on this PC (its database folder is not empty). Nothing was changed.',
    );
  }
  await mkdir(paths.dataDir, { recursive: true });
  const space = await statfs(paths.dataDir);
  if (space.bavail * space.bsize < MINIMUM_FREE_BYTES) {
    throw new InstallError('At least 10 GB of free disk space is needed.');
  }
  for (const [what, port] of [
    ['server', input.serverPort],
    ['database', input.databasePort],
  ] as const) {
    if (!(await portFree(port))) {
      throw new InstallError(`Port ${port} (the ${what}) is already in use by another program.`);
    }
  }
  log.line(
    `Windows build ${input.windowsBuild ?? 'n/a'}; ports ${input.serverPort} and ${input.databasePort} free.`,
  );

  step(2, 'folders and their access rules');
  // pgdata is made by initdb itself (step 3): initdb drops administrator rights while it runs,
  // so it could not write into a folder already closed to all but SYSTEM and Administrators.
  for (const dir of [paths.wal, paths.backups, paths.logs, paths.config, paths.setup, paths.tls]) {
    await mkdir(dir, { recursive: true });
  }
  await mkdir(join(paths.logs, 'server'), { recursive: true });
  await mkdir(join(paths.logs, 'backup'), { recursive: true });
  await mkdir(join(paths.secrets, 'backup'), { recursive: true });
  // Until each service exists, only SYSTEM and Administrators.
  for (const dir of [paths.wal, paths.backups, paths.logs, paths.config, paths.setup]) {
    await platform.restrictFolder(dir);
  }

  step(3, 'the database (PostgreSQL 18)');
  const password = process.env.PG_SUPERUSER_PASSWORD;
  if (!password)
    throw new InstallError('The database superuser password was not given by the launcher.');
  if (reattach) {
    log.line('The database folder of the earlier installation is kept as it is.');
    await platform.restrictFolder(paths.pgdata);
  } else {
    await createDatabaseFolder(input, password);
  }

  step(4, 'the database service');
  await platform.startDatabaseService(paths.pgdata);
  await platform.grantFolder(paths.wal, { service: 'database', access: 'modify' });

  step(5, 'the database roles, the empty database and its tables');
  const admin = new pg.Client({ ...connectionFor('superuser'), database: 'postgres' });
  await admin.connect();
  try {
    await assertServerVersion(admin);
    await ensureRoles(admin);
    const there = await databaseExists(admin, input.databaseName);
    if (reattach && !there) {
      throw new InstallError(
        `The database "${input.databaseName}" is not in the kept data folder; this needs support.`,
      );
    }
    if (!reattach && there) {
      throw new InstallError(
        `The database "${input.databaseName}" already exists. Nothing was changed.`,
      );
    }
    if (!reattach) await createAppDatabase(admin, input.databaseName);
  } finally {
    await admin.end();
  }
  if (reattach) {
    await preUpgradeCopy({
      fileName: reinstallCopyName(input.now ?? new Date()),
      databaseName: input.databaseName,
      backupsDir: paths.backups,
      pgBin: paths.pgBin,
      connection: connectionFor('backup', input.databaseName),
      log,
    });
  }
  const migrator = new pg.Client({
    ...connectionFor('migrator', input.databaseName),
    application_name: 'artepool-install',
  });
  await migrator.connect();
  try {
    // A reinstall may bring a newer version: its migrations all or nothing, as an upgrade.
    const applied = await migrate({ client: migrator, dir: migrationsDir, allOrNothing: reattach });
    log.line(`${applied.length} migrations applied.`);
  } finally {
    await migrator.end();
  }

  step(6, 'the certificates and the first-run setup files');
  const kept =
    reattach &&
    (await Promise.all(Object.values(TLS_FILES).map((file) => exists(join(paths.tls, file)))).then(
      (all) => all.every(Boolean),
    ));
  if (kept) {
    // The PCs already trust this CA: it stays.
    log.line('The certificates of the earlier installation are kept.');
  } else {
    const names = input.names ?? pcNames();
    const ca = await createCa(names);
    const server = await issueServerCert(ca, names);
    await writeTlsFile(paths.tls, TLS_FILES.caCert, ca.certPem);
    await writeTlsFile(paths.tls, TLS_FILES.caKey, ca.keyPem);
    await writeTlsFile(paths.tls, TLS_FILES.serverCert, server.certPem);
    await writeTlsFile(paths.tls, TLS_FILES.serverKey, server.keyPem);
    log.line(`Certificate names: ${[...names.dns, ...names.ips].join(', ')}.`);
  }
  if (reattach && (await setupFinished(input.databaseName))) {
    log.line('The first-run setup was finished earlier: it stays closed.');
    await rm(paths.tokenFile, { force: true });
  } else {
    await writeFile(
      join(paths.setup, 'ca.crt'),
      await readFile(join(paths.tls, TLS_FILES.caCert), 'utf8'),
    );
    const token = randomBytes(32).toString('base64url');
    log.hide(token);
    await writeFile(paths.tokenFile, `${token}\n`, { mode: 0o600 });
  }

  step(7, 'the server and backup services');
  for (const service of ['server', 'backup'] as const) await platform.registerAppService(service);
  await platform.grantFolder(paths.secrets, { service: 'server', access: 'read' });
  await platform.grantFolder(paths.secrets, { service: 'backup', access: 'read' });
  await platform.grantFolder(join(paths.secrets, 'backup'), {
    service: 'server',
    access: 'modify',
  });
  await platform.grantFolder(paths.config, { service: 'server', access: 'read' });
  await platform.grantFolder(paths.config, { service: 'backup', access: 'read' });
  await platform.grantFolder(paths.logs, { service: 'server', access: 'modify' });
  await platform.grantFolder(paths.logs, { service: 'backup', access: 'modify' });
  await platform.grantFolder(paths.backups, { service: 'backup', access: 'modify' });
  await platform.grantFolder(paths.backups, { service: 'server', access: 'read' });
  await platform.grantFolder(paths.wal, { service: 'backup', access: 'read' });
  // The server reads the setup token to let the wizard in, and deletes it at the end.
  await platform.grantFolder(paths.setup, { service: 'server', access: 'modify' });
  await platform.startService('server');
  await platform.startService('backup');

  step(8, 'the firewall');
  await platform.addFirewallRule(input.serverPort);

  step(9, 'the server answers');
  await input.waitHealthy(await readFile(join(paths.tls, TLS_FILES.caCert), 'utf8'));
  log.line(
    reattach
      ? 'ARTEPOOL is installed again with its data.'
      : 'ARTEPOOL is installed. The first-run setup opens next.',
  );
}
