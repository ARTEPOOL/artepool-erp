import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, inContext, setContext, type TestDatabase } from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let admin: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  admin = await db.connect('superuser');
});
afterAll(() => db.drop());

async function tryAs(client: pg.Client, sql: string, params: unknown[] = []): Promise<void> {
  await client.query('BEGIN');
  try {
    await setContext(client);
    await client.query(sql, params);
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('no hard deletes (golden rule 2)', () => {
  it('the API has no DELETE permission on business records', async () => {
    await expect(tryAs(api, 'DELETE FROM sys.branches')).rejects.toMatchObject({ code: '42501' });
    await expect(tryAs(api, 'DELETE FROM auth.users WHERE id = 1')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('even the database owner cannot delete or truncate them', async () => {
    await expect(tryAs(admin, 'DELETE FROM sys.branches')).rejects.toMatchObject({ code: 'AP002' });
    await expect(tryAs(admin, 'DELETE FROM auth.users WHERE id = 1')).rejects.toMatchObject({
      code: 'AP002',
    });
    await expect(tryAs(admin, 'TRUNCATE sys.settings CASCADE')).rejects.toMatchObject({
      code: 'AP002',
    });
  });

  it('link tables allow deleting a link, and the deletion is audited', async () => {
    await inContext(api, () =>
      api.query(
        `DELETE FROM auth.role_permissions
          WHERE role_id = (SELECT id FROM auth.roles WHERE code = 'technician')
            AND permission_code = 'customers.view'`,
      ),
    );
    const { rows } = await api.query<{
      entity_id: string;
      old_values: { permission_code: string };
    }>(
      `SELECT entity_id, old_values FROM audit.log
        WHERE entity_type = 'auth.role_permissions' AND action = 'delete'
          AND old_values ->> 'permission_code' = 'customers.view'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toMatch(/^\d+:customers\.view$/);
    expect(rows[0]!.old_values.permission_code).toBe('customers.view');
    await expect(tryAs(admin, 'TRUNCATE auth.role_permissions')).rejects.toMatchObject({
      code: 'AP002',
    });
  });
});

describe('final records (golden rule 3)', () => {
  it('an alert can be acknowledged once, and nothing else about it can change', async () => {
    const id = await inContext(api, async () => {
      const { rows } = await api.query<{ id: string }>(
        `INSERT INTO sys.alerts (alert_type, severity, dedupe_key) VALUES ('clock_skew', 'warning', 'pc-1')
         RETURNING id`,
      );
      return rows[0]!.id;
    });
    await expect(
      tryAs(admin, `UPDATE sys.alerts SET severity = 'info' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: 'AP003' });
    await inContext(api, () =>
      api.query(
        `UPDATE sys.alerts SET acknowledged_at = now(), acknowledged_by = 1, ack_note = 'checked' WHERE id = $1`,
        [id],
      ),
    );
    await expect(
      tryAs(api, `UPDATE sys.alerts SET ack_note = 'again' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: 'AP003' });
  });

  it('a committed import batch cannot change', async () => {
    const id = await inContext(api, async () => {
      const { rows } = await api.query<{ id: string }>(
        `INSERT INTO sys.import_batches (entity, file_name, file_sha256, status, rows_total, rows_valid, rows_invalid)
         VALUES ('items', 'items.xlsx', sha256('x'), 'validated', 3, 3, 0) RETURNING id`,
      );
      return rows[0]!.id;
    });
    await inContext(api, () =>
      api.query(
        `UPDATE sys.import_batches SET status = 'committed', committed_at = now(), committed_by = 1 WHERE id = $1`,
        [id],
      ),
    );
    await expect(
      tryAs(api, `UPDATE sys.import_batches SET status = 'rejected' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: 'AP003' });
  });
});

describe('draft lines guard', () => {
  beforeAll(async () => {
    await admin.query(`
      CREATE SCHEMA scratch;
      CREATE TABLE scratch.docs (id bigint PRIMARY KEY, status text NOT NULL);
      CREATE TABLE scratch.lines (id bigint PRIMARY KEY, doc_id bigint NOT NULL REFERENCES scratch.docs);
      CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON scratch.lines
        FOR EACH ROW EXECUTE FUNCTION sys.guard_draft_lines('scratch.docs', 'doc_id', 'status', 'draft');
      INSERT INTO scratch.docs VALUES (1, 'draft'), (2, 'issued');`);
  });

  it('allows line changes only while the document is a draft', async () => {
    await admin.query('INSERT INTO scratch.lines VALUES (10, 1)');
    await admin.query('UPDATE scratch.lines SET id = 11 WHERE id = 10');
    await expect(admin.query('INSERT INTO scratch.lines VALUES (20, 2)')).rejects.toMatchObject({
      code: 'AP006',
    });
    await expect(
      admin.query('UPDATE scratch.lines SET doc_id = 2 WHERE id = 11'),
    ).rejects.toMatchObject({
      code: 'AP006',
    });
    await admin.query(`UPDATE scratch.docs SET status = 'issued' WHERE id = 1`);
    await expect(admin.query('DELETE FROM scratch.lines WHERE id = 11')).rejects.toMatchObject({
      code: 'AP006',
    });
  });
});
