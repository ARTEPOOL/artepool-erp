/**
 * The hourly local copy (decision 0086) against a real PostgreSQL: a readable pg_dump file in the
 * backup folder, its run recorded with the fingerprint and the audit chain head (also anchored),
 * old copies removed, and a failure recorded with its message.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@artepool/testing';
import { configFromEnv, type BackupConfig } from '../../src/config';
import { connect } from '../../src/db';
import { localBackup } from '../../src/local';
import { backupFileName } from '../../src/retention';
import { sha256File } from '../../src/tools';

let db: TestDatabase;
let client: pg.Client;
let dir: string;
let config: BackupConfig;

beforeAll(async () => {
  db = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'artepool-backup-'));
  config = { ...configFromEnv(db.name), backupDir: dir };
  client = await connect(config.connection);
});
afterAll(async () => {
  await client.end();
  await rm(dir, { recursive: true, force: true });
  await db.drop();
});

describe('the local copy', () => {
  it('writes a readable copy and records it with its fingerprint and the chain head', async () => {
    const copy = await localBackup(client, config);
    expect(await readdir(dir)).toEqual([copy.fileName]);
    const { rows } = await client.query<{
      status: string;
      size_bytes: string;
      sha256: Buffer;
      audit_chain_seq: string;
      file_name: string;
      created_by: string;
    }>(
      `SELECT status, size_bytes::text, sha256, audit_chain_seq::text, file_name, created_by::text
          FROM ops.backup_runs WHERE id = $1`,
      [copy.runId],
    );
    const run = rows[0]!;
    expect(run.status).toBe('success');
    expect(run.created_by).toBe('1');
    expect(Number(run.size_bytes)).toBeGreaterThan(1000);
    expect(run.sha256.equals(await sha256File(copy.path))).toBe(true);
    const anchor = await client.query<{ chain_seq: string }>(
      `SELECT chain_seq::text FROM audit.anchors WHERE anchor_kind = 'backup' AND reference = $1`,
      [copy.fileName],
    );
    expect(anchor.rows[0]!.chain_seq).toBe(run.audit_chain_seq);
  });

  it('removes copies older than the 48 hourly + 30 daily it keeps', async () => {
    const old = backupFileName(new Date(Date.now() - 60 * 24 * 3600 * 1000));
    await writeFile(join(dir, old), 'old copy');
    await writeFile(join(dir, 'notes.txt'), 'not a copy');
    await localBackup(client, config);
    const names = await readdir(dir);
    expect(names).not.toContain(old);
    expect(names).toContain('notes.txt');
  });

  it('records a failure with its message', async () => {
    const broken = { ...config, pgBin: join(dir, 'no-such-folder') };
    await expect(localBackup(client, broken)).rejects.toThrow();
    const { rows } = await client.query<{ status: string; error_message: string }>(
      `SELECT status, error_message FROM ops.backup_runs ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error_message).toMatch(/pg_dump|ENOENT/);
  });
});
