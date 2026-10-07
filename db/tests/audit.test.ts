import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, inContext, setContext, type TestDatabase } from '@artepool/testing';

interface Verification {
  ok: boolean;
  checked: string;
  first_bad_seq: string | null;
  problem: string | null;
}

async function verify(client: pg.Client): Promise<Verification> {
  const { rows } = await client.query<Verification>('SELECT * FROM audit.verify_chain()');
  return rows[0]!;
}

async function headSeq(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ s: string }>(
    'SELECT last_seq::text AS s FROM audit.chain_head',
  );
  return Number(rows[0]!.s);
}

async function addBranch(client: pg.Client, code: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO sys.branches (code, name_ar, name_en) VALUES ($1, 'فرع', 'Branch') RETURNING id`,
    [code],
  );
  return rows[0]!.id;
}

describe('audit capture and sealing', () => {
  let db: TestDatabase;
  let api: pg.Client;
  let admin: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    api = await db.connect('api');
    admin = await db.connect('superuser');
  });
  afterAll(() => db.drop());

  it('records who, what, why — and seals the rows into the chain at commit', async () => {
    const before = await headSeq(api);
    await api.query('BEGIN');
    await api.query(
      `SELECT sys.set_context(1, NULL, NULL, '00000000-0000-0000-0000-0000000000aa', '192.168.1.20',
                              NULL, 'opening the Dubai branch')`,
    );
    const id = await addBranch(api, 'DXB');
    await addBranch(api, 'SHJ');
    const unsealed = await api.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM audit.log WHERE row_hash IS NULL',
    );
    expect(unsealed.rows[0]!.n).toBe('2'); // not sealed until commit
    await api.query('COMMIT');

    const { rows } = await api.query<{
      chain_seq: string;
      user_id: string;
      action: string;
      entity_type: string;
      entity_id: string;
      reason: string;
      request_id: string;
      ip: string;
      new_values: { code: string };
    }>(
      `SELECT chain_seq::text, user_id::text, action, entity_type, entity_id, reason, request_id::text,
              host(client_ip) AS ip, new_values
         FROM audit.log WHERE chain_seq > $1 ORDER BY chain_seq`,
      [before],
    );
    expect(rows.map((r) => Number(r.chain_seq))).toEqual([before + 1, before + 2]);
    expect(rows[0]).toMatchObject({
      user_id: '1',
      action: 'insert',
      entity_type: 'sys.branches',
      entity_id: id,
      reason: 'opening the Dubai branch',
      request_id: '00000000-0000-0000-0000-0000000000aa',
      ip: '192.168.1.20',
      new_values: { code: 'DXB' },
    });
    expect((await verify(api)).ok).toBe(true);
  });

  it('leaves no trace and no gap when the transaction is rolled back', async () => {
    const before = await headSeq(api);
    await api.query('BEGIN');
    await setContext(api);
    await addBranch(api, 'RAK');
    await api.query('ROLLBACK');
    expect(await headSeq(api)).toBe(before);
    await inContext(api, () => addBranch(api, 'FUJ'));
    expect(await headSeq(api)).toBe(before + 1);
    expect((await verify(api)).ok).toBe(true);
  });

  it('refuses any write without a user', async () => {
    await expect(addBranch(api, 'NOUSER')).rejects.toMatchObject({ code: 'AP001' });
  });

  it('logs only the columns that changed, and skips changes to ignored columns', async () => {
    const id = await inContext(api, async () => {
      const { rows } = await api.query<{ id: string }>(
        `INSERT INTO auth.users (username, display_name_ar, display_name_en, password_hash)
         VALUES ('sara', 'سارة', 'Sara', '$argon2id$super-secret-hash') RETURNING id`,
      );
      return rows[0]!.id;
    });
    const before = await headSeq(api);
    await inContext(api, () =>
      api.query('UPDATE auth.users SET last_login_at = now() WHERE id = $1', [id]),
    );
    expect(await headSeq(api)).toBe(before);

    await inContext(api, () =>
      api.query(
        `UPDATE auth.users SET display_name_en = 'Sarah', password_hash = '$argon2id$new' WHERE id = $1`,
        [id],
      ),
    );
    const { rows } = await api.query<{ old_values: object; new_values: object }>(
      `SELECT old_values, new_values FROM audit.log WHERE chain_seq = $1`,
      [before + 1],
    );
    expect(rows[0]).toEqual({
      old_values: { display_name_en: 'Sara', password_hash: '[redacted]' },
      new_values: { display_name_en: 'Sarah', password_hash: '[redacted]' },
    });
  });

  it('never stores secrets in the log', async () => {
    const { rows } = await api.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit.log
        WHERE coalesce(old_values::text, '') || coalesce(new_values::text, '') LIKE '%super-secret%'`,
    );
    expect(rows[0]!.n).toBe('0');
  });

  it('records business events, with or without a user for login events only', async () => {
    await inContext(api, () =>
      api.query(
        `SELECT audit.record_event('pos.cart_line_removed', 'pos.cart', 'cart-1', '{"item": 42}')`,
      ),
    );
    await api.query(
      `SELECT audit.record_event('auth.login_failed', NULL, NULL, '{"username": "x"}')`,
    );
    await expect(api.query(`SELECT audit.record_event('pos.no_sale')`)).rejects.toMatchObject({
      code: 'AP001',
    });
    await expect(api.query(`SELECT audit.record_event('Bad Name')`)).rejects.toMatchObject({
      code: '22023',
    });
    const { rows } = await api.query<{ action: string }>(
      `SELECT action FROM audit.log WHERE action LIKE 'event:%' ORDER BY id`,
    );
    expect(rows.map((r) => r.action)).toEqual([
      'event:pos.cart_line_removed',
      'event:auth.login_failed',
    ]);
    expect((await verify(api)).ok).toBe(true);
  });

  it('the API cannot write, change or delete log entries directly', async () => {
    for (const sql of [
      `INSERT INTO audit.log (action, user_id) VALUES ('insert', 1)`,
      `UPDATE audit.log SET reason = 'x'`,
      `DELETE FROM audit.log`,
      `UPDATE audit.chain_head SET last_seq = 0`,
    ]) {
      await expect(api.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('even the database owner cannot change, delete or truncate the log', async () => {
    for (const sql of [
      `UPDATE audit.log SET reason = 'x' WHERE chain_seq = 1`,
      `DELETE FROM audit.log WHERE chain_seq = 1`,
      `TRUNCATE audit.log`,
      `UPDATE audit.chain_head SET last_seq = 0`,
    ]) {
      await expect(admin.query(sql)).rejects.toMatchObject({ code: 'AP004' });
    }
  });

  it('keeps one unbroken chain when many terminals write at the same time', async () => {
    const before = await headSeq(api);
    const clients = await Promise.all(Array.from({ length: 10 }, () => db.connect('api')));
    await Promise.all(
      clients.map(async (client, c) => {
        for (let i = 0; i < 5; i++) {
          await inContext(client, async () => {
            await addBranch(client, `P${c}_${i}`);
            await addBranch(client, `Q${c}_${i}`);
          });
        }
      }),
    );
    expect(await headSeq(api)).toBe(before + 100);
    const { rows } = await api.query<{ n: string; min: string; max: string }>(
      'SELECT count(*)::text AS n, min(chain_seq)::text AS min, max(chain_seq)::text AS max FROM audit.log',
    );
    expect(Number(rows[0]!.n)).toBe(Number(rows[0]!.max)); // 1…max, no gaps
    expect((await verify(api)).ok).toBe(true);
  });

  it('records each verification run', async () => {
    await api.query('BEGIN');
    await setContext(api);
    const { rows } = await api.query<{ result: string; rows_checked: string }>(
      'SELECT result, rows_checked::text FROM audit.verify_and_record()',
    );
    await api.query('COMMIT');
    expect(rows[0]!.result).toBe('ok');
    expect(Number(rows[0]!.rows_checked)).toBeGreaterThan(100);
    const { rows: range } = await api.query<Verification>(
      'SELECT * FROM audit.verify_chain(5, 20)',
    );
    expect(range[0]).toMatchObject({ ok: true, checked: '16' });
  });
});

describe('tamper detection', () => {
  let db: TestDatabase;
  let api: pg.Client;
  let admin: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    api = await db.connect('api');
    admin = await db.connect('superuser');
    await inContext(api, async () => {
      for (const code of ['T1', 'T2', 'T3', 'T4', 'T5']) await addBranch(api, code);
    });
  });
  afterAll(() => db.drop());

  /** Simulates someone with full database access editing history behind the system's back. */
  async function asAttacker(sql: string): Promise<void> {
    await admin.query(`
      ALTER TABLE audit.log DISABLE TRIGGER guard_log;
      ALTER TABLE audit.chain_head DISABLE TRIGGER guard_head;
      ${sql};
      ALTER TABLE audit.log ENABLE TRIGGER guard_log;
      ALTER TABLE audit.chain_head ENABLE TRIGGER guard_head;`);
  }

  it('detects an edited entry at the exact place', async () => {
    const seq = (await headSeq(api)) - 2;
    await asAttacker(`UPDATE audit.log SET new_values = jsonb_set(new_values, '{name_en}', '"Edited"')
                       WHERE chain_seq = ${seq}`);
    expect(await verify(api)).toMatchObject({
      ok: false,
      first_bad_seq: String(seq),
      problem: `Entry #${seq} was changed after it was written`,
    });
  });

  it('detects a deleted entry', async () => {
    const fresh = await createTestDatabase();
    const client = await fresh.connect('api');
    const attacker = await fresh.connect('superuser');
    await inContext(client, () => addBranch(client, 'X1'));
    await inContext(client, () => addBranch(client, 'X2'));
    const seq = (await headSeq(client)) - 1;
    await attacker.query(`ALTER TABLE audit.log DISABLE TRIGGER guard_log;
                          DELETE FROM audit.log WHERE chain_seq = ${seq};
                          ALTER TABLE audit.log ENABLE TRIGGER guard_log;`);
    expect(await verify(client)).toMatchObject({ ok: false, first_bad_seq: String(seq) });
    await fresh.drop();
  });

  it('a fully rewritten chain is still caught by the fingerprint printed on a Z report', async () => {
    const fresh = await createTestDatabase();
    const client = await fresh.connect('api');
    const attacker = await fresh.connect('superuser');
    await inContext(client, () => addBranch(client, 'Y1'));
    await client.query('BEGIN');
    await setContext(client);
    await client.query(`SELECT audit.add_anchor('z_report', 'Z-000001')`);
    await client.query('COMMIT');
    const anchored = await headSeq(client);
    await inContext(client, () => addBranch(client, 'Y2'));

    // Rewrite the anchored entry AND recompute every later fingerprint and the head.
    await attacker.query(`
      ALTER TABLE audit.log DISABLE TRIGGER guard_log;
      ALTER TABLE audit.chain_head DISABLE TRIGGER guard_head;
      UPDATE audit.log SET reason = 'rewritten' WHERE chain_seq = ${anchored};
      DO $$
      DECLARE r audit.log; prev bytea;
      BEGIN
        SELECT row_hash INTO prev FROM audit.log WHERE chain_seq = ${anchored} - 1;
        FOR r IN SELECT * FROM audit.log WHERE chain_seq >= ${anchored} ORDER BY chain_seq LOOP
          UPDATE audit.log SET prev_hash = prev, row_hash = audit.compute_hash(prev, r.chain_seq, r) WHERE id = r.id;
          prev := audit.compute_hash(prev, r.chain_seq, r);
        END LOOP;
        UPDATE audit.chain_head SET last_hash = prev;
      END $$;
      ALTER TABLE audit.log ENABLE TRIGGER guard_log;
      ALTER TABLE audit.chain_head ENABLE TRIGGER guard_head;`);

    expect(await verify(client)).toMatchObject({
      ok: false,
      first_bad_seq: String(anchored),
      problem: expect.stringContaining('fingerprint recorded on z_report Z-000001') as unknown,
    });
    await fresh.drop();
  });
});
