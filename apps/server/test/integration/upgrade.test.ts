/**
 * Upgrading the server PC (decision 0103, M6.2 part G2) on a real PostgreSQL with a fake Windows:
 * the pre-upgrade copy (checked, SHA-256 beside it), the services stopped and started in order, an
 * open shift or an older version refusing before anything changes, the new migrations applied all
 * or nothing, and a new version that does not answer after its migrations putting the database
 * back from the pre-upgrade copy (the upgraded one kept aside).
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv, sha256File } from '@artepool/backup';
import { connectionFor, migrationsDir } from '@artepool/node-kit';
import { createTestDatabase, type TestDatabase } from '@artepool/testing';
import { InstallLog } from '../../src/cli/install/log';
import type { ServiceKey } from '../../src/cli/install/windows';
import {
  applyUpgrade,
  compareVersions,
  failureText,
  KEEP_PRE_UPGRADE,
  postgresMajor,
  preUpgradeFileName,
  prepareUpgrade,
  UpgradeError,
  type UpgradeConnections,
  type UpgradePlatform,
} from '../../src/cli/upgrade/steps';

let root: string;
let db: TestDatabase;
let connections: UpgradeConnections;
let pgBin: string;
let last: number;
/** The migrations the database has now (the repository's, then each applied test version's). */
let currentDir: string;

function fakePlatform() {
  const calls: string[] = [];
  const platform: UpgradePlatform = {
    startService: (s: ServiceKey) => Promise.resolve(void calls.push(`start ${s}`)),
    stopService: (s: ServiceKey) => Promise.resolve(void calls.push(`stop ${s}`)),
    refreshAppService: (s) => Promise.resolve(void calls.push(`refresh ${s}`)),
    registerUpdaterTask: () => Promise.resolve(void calls.push('updater task')),
  };
  return { platform, calls };
}

const quietLog = () => new InstallLog(null, () => undefined);

/** The repository's migrations plus the given new ones, numbered after the last. */
async function migrationsWith(name: string, extra: string[]): Promise<string> {
  const dir = join(root, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of await readdir(migrationsDir)) {
    if (file.endsWith('.sql')) await copyFile(join(migrationsDir, file), join(dir, file));
  }
  for (const [i, sql] of extra.entries()) {
    const version = String(last + i + 1).padStart(4, '0');
    await writeFile(join(dir, `${version}_upgrade_test_${i + 1}.sql`), sql);
  }
  return dir;
}

async function query<T extends pg.QueryResultRow>(sql: string, database = db.name): Promise<T[]> {
  const client = new pg.Client({ ...connectionFor('superuser'), database });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

const tableExists = async (name: string) =>
  (await query<{ t: string | null }>(`SELECT to_regclass('${name}')::text AS t`))[0]!.t !== null;

async function prepare(platform: UpgradePlatform, from: string, to: string, now: Date) {
  return prepareUpgrade({
    from,
    to,
    dataPgMajor: 18,
    bundledPgMajor: 18,
    databaseName: db.name,
    migrationsDir: currentDir,
    backupsDir: join(root, 'backups'),
    pgBin,
    connections,
    platform,
    log: quietLog(),
    now,
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'artepool-upgrade-'));
  db = await createTestDatabase();
  connections = {
    backup: connectionFor('backup', db.name),
    migrator: connectionFor('migrator', db.name),
    superuser: connectionFor('superuser'),
  };
  pgBin = configFromEnv(db.name).pgBin;
  last = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).length;
  currentDir = migrationsDir;
}, 120_000);

afterAll(async () => {
  const admin = new pg.Client({ ...connectionFor('superuser'), database: 'postgres' });
  await admin.connect();
  const { rows } = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE $1 AND datname <> $2`,
    [`${db.name.slice(0, 30)}%`, db.name],
  );
  for (const { datname } of rows) {
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(datname)} WITH (FORCE)`);
  }
  await admin.end();
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

describe('versions', () => {
  it('compares x.y.z versions and reads the PostgreSQL major version', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('0.9.1', '0.10.0')).toBeLessThan(0);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(UpgradeError);
    expect(postgresMajor('postgres (PostgreSQL) 18.1\n')).toBe(18);
    expect(postgresMajor('nothing')).toBeNull();
    expect(preUpgradeFileName('1.4.0', '1.5.0', new Date('2026-10-25T09:30:00Z'))).toBe(
      'artepool-20261025-093000Z-1.4.0-to-1.5.0.dump',
    );
  });

  it('writes the reason for the setup as two short ASCII lines', () => {
    expect(failureText('migrate', 'Upgrade 1.0.0 → 1.1.0:\nبوظ')).toBe(
      'migrate\r\nUpgrade 1.0.0 -> 1.1.0: ???\r\n',
    );
    expect(failureText('checks', 'x'.repeat(2000)).length).toBeLessThan(720);
  });
});

describe('the server upgrade', () => {
  it('refuses an older or equal version, or another PostgreSQL, before touching anything', async () => {
    const { platform, calls } = fakePlatform();
    await expect(prepare(platform, '1.2.0', '1.2.0', new Date())).rejects.toMatchObject({
      step: 'checks',
    });
    await expect(prepare(platform, '1.2.0', '1.1.9', new Date())).rejects.toMatchObject({
      step: 'checks',
    });
    await expect(
      prepareUpgrade({
        from: '1.0.0',
        to: '1.1.0',
        dataPgMajor: 18,
        bundledPgMajor: 19,
        databaseName: db.name,
        migrationsDir,
        backupsDir: join(root, 'backups'),
        pgBin,
        connections,
        platform,
        log: quietLog(),
      }),
    ).rejects.toThrow(/PostgreSQL 18.*PostgreSQL 19/);
    expect(calls).toEqual([]);
  });

  it('makes a checked pre-upgrade copy, then stops the database for the folder swap', async () => {
    const { platform, calls } = fakePlatform();
    const now = new Date('2026-10-25T09:30:00Z');
    const prepared = await prepare(platform, '1.0.0', '1.1.0', now);

    expect(prepared.backup).toBe(
      join(root, 'backups', 'pre-upgrade', 'artepool-20261025-093000Z-1.0.0-to-1.1.0.dump'),
    );
    expect(prepared.sha256).toBe((await sha256File(prepared.backup)).toString('hex'));
    expect(await readFile(`${prepared.backup}.sha256`, 'utf8')).toBe(
      `${prepared.sha256}  artepool-20261025-093000Z-1.0.0-to-1.1.0.dump\n`,
    );
    expect(calls).toEqual(['stop backup', 'stop server', 'stop database']);
  });

  it('keeps only the newest pre-upgrade copies', async () => {
    const { platform } = fakePlatform();
    for (let i = 0; i < KEEP_PRE_UPGRADE + 1; i++) {
      await prepare(platform, '1.0.0', '1.1.0', new Date(Date.UTC(2026, 10, 1, 0, 0, i)));
    }
    const left = (await readdir(join(root, 'backups', 'pre-upgrade'))).filter((n) =>
      n.endsWith('.dump'),
    );
    expect(left).toHaveLength(KEEP_PRE_UPGRADE);
    expect(left).not.toContain('artepool-20261025-093000Z-1.0.0-to-1.1.0.dump');
  }, 120_000);

  it('applies the new migrations, starts the services and records the upgrade', async () => {
    const { platform, calls } = fakePlatform();
    const prepared = await prepare(platform, '1.0.0', '1.1.0', new Date());
    calls.length = 0;
    const dir = await migrationsWith('v110', ['CREATE TABLE sys.upgrade_test_one (id int);']);
    let healthCa = '';
    const caFile = join(root, 'ca.crt');
    await writeFile(caFile, 'the CA');

    const result = await applyUpgrade({
      from: '1.0.0',
      to: '1.1.0',
      backup: prepared.backup,
      databaseName: db.name,
      migrationsDir: dir,
      pgBin,
      tlsCaFile: caFile,
      connections,
      platform,
      log: quietLog(),
      waitHealthy: (ca) => Promise.resolve(void (healthCa = ca)),
    });

    expect(result).toMatchObject({ ok: true, from: '1.0.0', to: '1.1.0', migrations: 1 });
    currentDir = dir;
    expect(healthCa).toBe('the CA');
    expect(calls).toEqual([
      'refresh server',
      'refresh backup',
      'updater task',
      'start database',
      'start server',
      'start backup',
    ]);
    expect(await tableExists('sys.upgrade_test_one')).toBe(true);
    const events = await query<{ new_values: { from: string; to: string; migrations: number } }>(
      `SELECT new_values FROM audit.log WHERE action = 'event:system.upgraded'`,
    );
    expect(events.map((e) => e.new_values)).toEqual([
      expect.objectContaining({ from: '1.0.0', to: '1.1.0', migrations: 1 }),
    ]);
  });

  it('leaves the database unchanged when a migration fails, and stops every service', async () => {
    const { platform, calls } = fakePlatform();
    const prepared = await prepare(platform, '1.1.0', '1.2.0', new Date());
    calls.length = 0;
    const before = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sys.schema_migrations',
    );
    const dir = await migrationsWith('v120-broken', [
      'CREATE TABLE sys.upgrade_test_one (id int);',
      'CREATE TABLE sys.upgrade_test_two (id int);',
      'CREATE TABLE sys.upgrade_test_three (id int); SELECT 1 / 0;',
    ]);

    const result = await applyUpgrade({
      from: '1.1.0',
      to: '1.2.0',
      backup: prepared.backup,
      databaseName: db.name,
      migrationsDir: dir,
      pgBin,
      tlsCaFile: join(root, 'ca.crt'),
      connections,
      platform,
      log: quietLog(),
      waitHealthy: () => Promise.resolve(),
    });

    expect(result).toMatchObject({ ok: false, step: 'migrate', databasePutBack: false });
    expect(await tableExists('sys.upgrade_test_two')).toBe(false);
    expect(await query('SELECT count(*)::int AS n FROM sys.schema_migrations')).toEqual(before);
    expect(calls.slice(-3)).toEqual(['stop backup', 'stop server', 'stop database']);
    expect(calls).not.toContain('start server');
  });

  it('puts the database back from the pre-upgrade copy when the new version does not answer', async () => {
    const { platform, calls } = fakePlatform();
    const now = new Date('2026-10-26T01:00:00Z');
    const prepared = await prepare(platform, '1.1.0', '1.2.0', now);
    calls.length = 0;
    const dir = await migrationsWith('v120', [
      'CREATE TABLE sys.upgrade_test_one (id int);',
      'CREATE TABLE sys.upgrade_test_two (id int);',
    ]);

    const result = await applyUpgrade({
      from: '1.1.0',
      to: '1.2.0',
      backup: prepared.backup,
      databaseName: db.name,
      migrationsDir: dir,
      pgBin,
      tlsCaFile: join(root, 'ca.crt'),
      connections,
      platform,
      log: quietLog(),
      waitHealthy: () => Promise.reject(new Error('no answer')),
      now,
    });

    expect(result).toMatchObject({
      ok: false,
      step: 'health',
      detail: 'no answer',
      databasePutBack: true,
    });
    // Back as before: the first new table is there (1.1.0), the second is not.
    expect(await tableExists('sys.upgrade_test_one')).toBe(true);
    expect(await tableExists('sys.upgrade_test_two')).toBe(false);
    const failed = await query<{ new_values: { step: string } }>(
      `SELECT new_values FROM audit.log WHERE action = 'event:system.upgrade_failed'`,
    );
    expect(failed.map((e) => e.new_values.step)).toContain('health');
    // The upgraded database is kept aside, never deleted.
    const aside = `${db.name.slice(0, 63 - '_failed_upgrade_20261026010000'.length)}_failed_upgrade_20261026010000`;
    const kept = await query<{ t: string | null }>(
      `SELECT to_regclass('sys.upgrade_test_two')::text AS t`,
      aside,
    );
    expect(kept[0]!.t).not.toBeNull();
    expect(calls.slice(-3)).toEqual(['stop backup', 'stop server', 'stop database']);
  }, 120_000);

  it('refuses a version that lacks a migration the database has, before stopping anything', async () => {
    const { platform, calls } = fakePlatform();
    const refused = prepareUpgrade({
      from: '1.1.0',
      to: '1.3.0',
      dataPgMajor: 18,
      bundledPgMajor: 18,
      databaseName: db.name,
      migrationsDir, // the repository's: without the test version's migration applied above
      backupsDir: join(root, 'backups'),
      pgBin,
      connections,
      platform,
      log: quietLog(),
    });
    await expect(refused).rejects.toMatchObject({ step: 'checks' });
    await expect(refused).rejects.toThrow(/file is missing\. Nothing was changed\./);
    expect(calls).toEqual([]);
  });

  it('says in plain words that a CI test version changed the database', async () => {
    const { platform, calls } = fakePlatform();
    const su = await db.connect('superuser');
    try {
      await su.query(
        `INSERT INTO sys.schema_migrations (version, name, checksum_sha256, applied_by, execution_ms)
         VALUES (9000, 'ci_upgrade_check', 'x', 'ci', 0)`,
      );
      const refused = prepare(platform, '1.1.0', '1.3.0', new Date());
      await expect(refused).rejects.toMatchObject({ step: 'test_version' });
      await expect(refused).rejects.toThrow(/test version from the CI tests.*Nothing was changed/);
      expect(calls).toEqual([]);
    } finally {
      await su.query('DELETE FROM sys.schema_migrations WHERE version = 9000');
      await su.end();
    }
  });

  it('refuses while a shift is open, and starts the services again', async () => {
    const { platform, calls } = fakePlatform();
    const su = await db.connect('superuser');
    try {
      // Only the count matters here: the shift's references are not needed.
      await su.query(`SET session_replication_role = replica`);
      await su.query(
        `INSERT INTO cash.shifts (series_id, seq_no, shift_number, register_id, cashier_id,
                                  opened_by, opening_float_fils, created_by, updated_by)
         VALUES (1, 1, 'SH-TEST', 1, 1, 1, 0, 1, 1)`,
      );
    } finally {
      await su.end();
    }
    await expect(prepare(platform, '1.2.0', '1.3.0', new Date())).rejects.toMatchObject({
      step: 'open_shift',
    });
    expect(calls).toEqual([
      'stop backup',
      'stop server',
      'start database',
      'start server',
      'start backup',
    ]);
  });
});
