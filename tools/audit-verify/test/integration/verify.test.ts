import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, inContext, type TestDatabase } from '@artepool/testing';
import { describeCheck, verifyAuditChain } from '../../src';

let db: TestDatabase;
let api: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
});
afterAll(() => db.drop());

describe('audit:verify', () => {
  it('reports an intact chain in plain words, and records the check', async () => {
    const check = await verifyAuditChain(api);
    expect(check).toMatchObject({ ok: true, firstBadEntry: null });
    expect(check.rowsChecked).toBe(check.lastEntry); // every entry that existed when the check ran
    expect(describeCheck(check)).toMatch(/^OK — the audit chain is intact/);
    const { rowCount } = await api.query(
      `SELECT 1 FROM audit.log WHERE action = 'event:audit.verify'`,
    );
    expect(rowCount).toBe(1);
  });

  it('reports tampering with the exact entry and what to do', async () => {
    await inContext(api, () =>
      api.query(`INSERT INTO sys.branches (code, name_ar, name_en) VALUES ('V1', 'ف', 'V1')`),
    );
    const admin = await db.connect('superuser');
    await admin.query(`
      ALTER TABLE audit.log DISABLE TRIGGER guard_log;
      UPDATE audit.log SET reason = 'edited' WHERE chain_seq = 3;
      ALTER TABLE audit.log ENABLE TRIGGER guard_log;`);
    const check = await verifyAuditChain(api);
    expect(check).toMatchObject({ ok: false, firstBadEntry: 3 });
    const text = describeCheck(check);
    expect(text).toContain('BROKEN');
    expect(text).toContain('Entry #3 was changed after it was written');
  });
});
