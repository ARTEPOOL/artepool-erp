import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyTestDatabase, type TestDatabase } from '@artepool/testing';
import { createMigrationFile, migrate, migrationStatus } from '../../src';

let db: TestDatabase;
let client: pg.Client;
let dir: string;

function write(fileName: string, sql: string): void {
  writeFileSync(join(dir, fileName), sql);
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await client.query<{ t: string | null }>('SELECT to_regclass($1) AS t', [name]);
  return rows[0]?.t !== null;
}

beforeEach(async () => {
  db = await createEmptyTestDatabase();
  client = await db.connect('migrator');
  dir = mkdtempSync(join(tmpdir(), 'artepool-migrations-'));
});

afterEach(async () => {
  await db.drop();
});

describe('migration runner', () => {
  it('applies migrations in order, as the owner role, and only once', async () => {
    write('0001_first.sql', 'CREATE TABLE sys.first (id int);');
    write('0002_second.sql', 'CREATE TABLE sys.second (id int);');
    expect((await migrate({ client, dir })).map((f) => f.fileName)).toEqual([
      '0001_first.sql',
      '0002_second.sql',
    ]);
    expect(await migrate({ client, dir })).toEqual([]);

    const { rows } = await client.query<{ owner: string }>(
      `SELECT tableowner AS owner FROM pg_tables WHERE schemaname = 'sys' AND tablename = 'first'`,
    );
    expect(rows[0]?.owner).toBe('artepool_owner');
    const status = await migrationStatus(client, dir);
    expect(status.applied.map((a) => a.version)).toEqual([1, 2]);
    expect(status.pending).toEqual([]);
  });

  it('refuses to run when an applied migration was edited', async () => {
    write('0001_first.sql', 'CREATE TABLE sys.first (id int);');
    await migrate({ client, dir });
    write('0001_first.sql', 'CREATE TABLE sys.first (id int, extra int);');
    await expect(migrate({ client, dir })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  });

  it('treats Windows line endings as the same file', async () => {
    write('0001_first.sql', 'CREATE TABLE sys.first (id int);\nSELECT 1;\n');
    await migrate({ client, dir });
    write('0001_first.sql', 'CREATE TABLE sys.first (id int);\r\nSELECT 1;\r\n');
    await expect(migrate({ client, dir })).resolves.toEqual([]);
  });

  it('rolls a failing migration back completely and reports the line', async () => {
    write('0001_first.sql', 'CREATE TABLE sys.first (id int);');
    write(
      '0002_broken.sql',
      'CREATE TABLE sys.second (id int);\nSELECT no_such_column FROM sys.second;',
    );
    await expect(migrate({ client, dir })).rejects.toMatchObject({
      code: 'FAILED',
      message: expect.stringContaining('0002_broken.sql (line 2)') as unknown,
    });
    expect(await tableExists('sys.first')).toBe(true);
    expect(await tableExists('sys.second')).toBe(false);
    const status = await migrationStatus(client, dir);
    expect(status.applied).toHaveLength(1);
  });

  it('refuses gaps, bad names and transaction statements', async () => {
    write('0001_first.sql', 'SELECT 1;');
    write('0003_third.sql', 'SELECT 1;');
    await expect(migrate({ client, dir })).rejects.toMatchObject({ code: 'NUMBERING_GAP' });

    dir = mkdtempSync(join(tmpdir(), 'artepool-migrations-'));
    write('1_bad name.sql', 'SELECT 1;');
    await expect(migrate({ client, dir })).rejects.toMatchObject({ code: 'BAD_FILE_NAME' });

    dir = mkdtempSync(join(tmpdir(), 'artepool-migrations-'));
    write('0001_tx.sql', 'BEGIN;\nSELECT 1;\nCOMMIT;');
    await expect(migrate({ client, dir })).rejects.toMatchObject({ code: 'FORBIDDEN_STATEMENT' });
  });

  it('allows PL/pgSQL blocks that contain BEGIN and END', async () => {
    write(
      '0001_function.sql',
      `CREATE FUNCTION sys.f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  BEGIN\n    RETURN 1;\n  END;\nEND $$;`,
    );
    await expect(migrate({ client, dir })).resolves.toHaveLength(1);
  });

  it('reports a migration whose file has disappeared', async () => {
    write('0001_first.sql', 'SELECT 1;');
    await migrate({ client, dir });
    dir = mkdtempSync(join(tmpdir(), 'artepool-migrations-'));
    await expect(migrate({ client, dir })).rejects.toMatchObject({ code: 'MISSING_FILE' });
  });

  it('refuses to run twice at the same time', async () => {
    write('0001_first.sql', 'SELECT 1;');
    const other = await db.connect('migrator');
    await other.query('SELECT pg_advisory_lock(7340211982)');
    await expect(migrate({ client, dir })).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
    await other.query('SELECT pg_advisory_unlock(7340211982)');
    await expect(migrate({ client, dir })).resolves.toHaveLength(1);
  });

  it('dry run checks everything and changes nothing', async () => {
    write('0001_first.sql', 'CREATE TABLE sys.first (id int);');
    expect(await migrate({ client, dir, dryRun: true })).toHaveLength(1);
    expect(await tableExists('sys.first')).toBe(false);
    expect(await tableExists('sys.schema_migrations')).toBe(false);
  });

  it('all-or-nothing (upgrades): applies every pending migration together', async () => {
    write('0001_first.sql', 'CREATE TABLE sys.first (id int);');
    await migrate({ client, dir });
    write('0002_second.sql', 'CREATE TABLE sys.second (id int);');
    write('0003_third.sql', 'CREATE TABLE sys.third (id int);');
    const done = await migrate({ client, dir, allOrNothing: true });
    expect(done.map((f) => f.version)).toEqual([2, 3]);
    expect(await tableExists('sys.third')).toBe(true);
    expect((await migrationStatus(client, dir)).applied.map((a) => a.version)).toEqual([1, 2, 3]);
    expect(await migrate({ client, dir, allOrNothing: true })).toEqual([]);
  });

  it('all-or-nothing: one broken migration leaves the database exactly as it was', async () => {
    write('0001_first.sql', 'CREATE TABLE sys.first (id int);');
    await migrate({ client, dir });
    write('0002_second.sql', 'CREATE TABLE sys.second (id int);');
    write('0003_broken.sql', 'CREATE TABLE sys.third (id int);\nSELECT nope FROM sys.third;');
    await expect(migrate({ client, dir, allOrNothing: true })).rejects.toMatchObject({
      code: 'FAILED',
      message: expect.stringContaining('0003_broken.sql (line 2)') as unknown,
    });
    // Unlike one transaction per file, 0002 is not kept either.
    expect(await tableExists('sys.second')).toBe(false);
    expect(await tableExists('sys.third')).toBe(false);
    expect((await migrationStatus(client, dir)).applied.map((a) => a.version)).toEqual([1]);
  });

  it('all-or-nothing: an edited applied migration stops it before anything runs', async () => {
    write('0001_first.sql', 'CREATE TABLE sys.first (id int);');
    await migrate({ client, dir });
    write('0001_first.sql', 'CREATE TABLE sys.first (id int, extra int);');
    write('0002_second.sql', 'CREATE TABLE sys.second (id int);');
    await expect(migrate({ client, dir, allOrNothing: true })).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH',
    });
    expect(await tableExists('sys.second')).toBe(false);
  });

  it('creates the next numbered migration file', () => {
    write('0001_first.sql', 'SELECT 1;');
    createMigrationFile(dir, 'add_things');
    expect(readdirSync(dir).sort()).toEqual(['0001_first.sql', '0002_add_things.sql']);
    expect(() => createMigrationFile(dir, 'Bad Name')).toThrow();
  });
});
