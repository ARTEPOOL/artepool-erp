/**
 * Decision 0054: stock adjustments and count differences need no supervisor's approval by
 * default (the limit is empty); a large increase posts straight away. The rule itself is tested
 * with the limit on in inventory.test.ts.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, createUser, type TestDatabase } from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  await createUser(api, { username: 'owner.def', roles: ['owner'], signInMethod: 'password_totp' });
});
afterAll(() => db.drop());

describe('approval limit (decision 0054)', () => {
  it('is empty by default: no supervisor approval for stock adjustments', async () => {
    const { rows } = await api.query<{ v: string | null }>(
      `SELECT sys.setting_bigint('inventory.adjustment_approval_threshold_fils')::text AS v`,
    );
    expect(rows[0]!.v).toBeNull();
  });
});
