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

async function attempt(client: pg.Client, sql: string, params: unknown[] = []): Promise<void> {
  await client.query('BEGIN');
  try {
    await setContext(client);
    await client.query(sql, params);
  } finally {
    await client.query('ROLLBACK');
  }
}

async function seriesId(code: string): Promise<string> {
  const { rows } = await api.query<{ id: string }>(
    'SELECT id FROM sys.document_series WHERE code = $1',
    [code],
  );
  return rows[0]!.id;
}

async function nextNumber(
  client: pg.Client,
  series: string,
): Promise<{ seq_no: string; formatted: string }> {
  const { rows } = await client.query<{ seq_no: string; formatted: string }>(
    'SELECT seq_no::text, formatted FROM sys.next_number($1)',
    [series],
  );
  return rows[0]!;
}

describe('settings', () => {
  it('has the agreed defaults', async () => {
    const { rows } = await api.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM sys.settings',
    );
    const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(settings).toMatchObject({
      'pos.out_of_stock_mode': 'allow_with_approval',
      'print.mark_reprints_as_copy': true,
      'print.pos_receipt_auto': true,
      'einvoice.mandatory_from': null,
      'security.max_failed_logins': 5,
    });
    expect(rows).toHaveLength(28); // 22 from 0004 + 6 security settings from 0005
  });

  it('values can be edited (audited, versioned); keys cannot be added by the app', async () => {
    await inContext(api, () =>
      api.query(`UPDATE sys.settings SET value = '10' WHERE key = 'security.lockout_minutes'`),
    );
    const { rows } = await api.query<{ v: string }>(
      `SELECT row_version::text AS v FROM sys.settings WHERE key = 'security.lockout_minutes'`,
    );
    expect(rows[0]!.v).toBe('2');
    await expect(
      attempt(api, `INSERT INTO sys.settings (key, value) VALUES ('x.y', '1')`),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('company profile', () => {
  const insert = (fields: string, values: string) =>
    `INSERT INTO sys.company_profile (id, legal_name_ar, legal_name_en, address_ar, address_en, vat_registered${fields})
     VALUES (1, 'آرتيبول', 'ARTÉPOOL', 'العين', 'Al Ain'${values})`;

  it('requires a valid 15-digit TRN when VAT-registered, and allows only one row', async () => {
    await expect(attempt(api, insert('', ', true'))).rejects.toMatchObject({ code: '23514' });
    await expect(attempt(api, insert(', trn', `, true, '12345'`))).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      attempt(api, insert(', trn', `, true, '100000000000003'`).replace('VALUES (1', 'VALUES (2')),
    ).rejects.toMatchObject({ code: '23514' });
    await attempt(api, insert(', trn', `, true, '100000000000003'`));
  });
});

describe('gapless numbering (golden rule 5)', () => {
  it('has the 13 agreed series', async () => {
    const { rows } = await api.query<{ code: string; prefix: string; channel: string | null }>(
      'SELECT code, prefix, channel FROM sys.document_series ORDER BY id',
    );
    expect(rows.map((r) => r.prefix)).toEqual([
      'POS-',
      'INV-',
      'CN-',
      'DN-',
      'Q-',
      'RCT-',
      'RFD-',
      'RVS-',
      'CV-',
      'Z-',
      'ADJ-',
      'CNT-',
      'JV-',
    ]);
    expect(rows.find((r) => r.code === 'POS')!.channel).toBe('pos');
    expect(rows.find((r) => r.code === 'INV')!.channel).toBe('office');
  });

  it('formats numbers, and a rolled-back transaction gives its number back', async () => {
    const pos = await seriesId('POS');
    await api.query('BEGIN');
    await setContext(api);
    expect(await nextNumber(api, pos)).toEqual({ seq_no: '1', formatted: 'POS-000001' });
    await api.query('ROLLBACK');
    await api.query('BEGIN');
    await setContext(api);
    expect(await nextNumber(api, pos)).toEqual({ seq_no: '1', formatted: 'POS-000001' });
    expect(await nextNumber(api, pos)).toEqual({ seq_no: '2', formatted: 'POS-000002' });
    await api.query('COMMIT');
  });

  it('never cuts digits when a number outgrows its width', async () => {
    const id = await inContext(api, async () => {
      const { rows } = await api.query<{ id: string }>(
        `INSERT INTO sys.document_series (doc_type, branch_id, code, prefix, number_width, start_number)
         SELECT 'journal', id, 'JV2', 'JV2-', 2, 99 FROM sys.branches WHERE code = 'HQ' RETURNING id`,
      );
      return rows[0]!.id;
    });
    await api.query('BEGIN');
    await setContext(api);
    expect((await nextNumber(api, id)).formatted).toBe('JV2-99');
    expect((await nextNumber(api, id)).formatted).toBe('JV2-100');
    await api.query('COMMIT');
  });

  it('50 simultaneous requests, some cancelled, still give 1, 2, 3… with no gaps or repeats', async () => {
    const series = await seriesId('Q');
    const clients = await Promise.all(Array.from({ length: 10 }, () => db.connect('api')));
    const committed: number[] = [];
    let cancelled = 0;
    await Promise.all(
      clients.map(async (client, c) => {
        for (let i = 0; i < 5; i++) {
          await client.query('BEGIN');
          await setContext(client);
          const { seq_no } = await nextNumber(client, series);
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
          if ((c + i) % 3 === 0) {
            await client.query('ROLLBACK');
            cancelled++;
          } else {
            await client.query('COMMIT');
            committed.push(Number(seq_no));
          }
        }
      }),
    );
    expect(cancelled).toBeGreaterThan(0);
    expect(committed.sort((a, b) => a - b)).toEqual(
      Array.from({ length: committed.length }, (_, i) => i + 1),
    );
    const { rows } = await api.query<{ n: string }>(
      'SELECT next_number::text AS n FROM sys.document_series WHERE id = $1',
      [series],
    );
    expect(Number(rows[0]!.n)).toBe(committed.length + 1);
  });

  it('the counter cannot be moved by hand, and a series cannot be redefined', async () => {
    const cn = await seriesId('CN');
    await expect(
      attempt(api, 'UPDATE sys.document_series SET next_number = 100 WHERE id = $1', [cn]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      attempt(admin, 'UPDATE sys.document_series SET next_number = next_number + 2 WHERE id = $1', [
        cn,
      ]),
    ).rejects.toMatchObject({ code: 'AP005' });
    await expect(
      attempt(admin, `UPDATE sys.document_series SET prefix = 'XX-' WHERE id = $1`, [cn]),
    ).rejects.toMatchObject({ code: 'AP003' });
  });

  it('refuses inactive series and invoice series without a channel', async () => {
    const dn = await seriesId('DN');
    await inContext(api, () =>
      api.query('UPDATE sys.document_series SET is_active = false WHERE id = $1', [dn]),
    );
    await expect(attempt(api, 'SELECT * FROM sys.next_number($1)', [dn])).rejects.toMatchObject({
      code: 'AP007',
    });
    await expect(
      attempt(
        api,
        `INSERT INTO sys.document_series (doc_type, branch_id, code, prefix)
         SELECT 'invoice', id, 'INV2', 'INV2-' FROM sys.branches WHERE code = 'HQ'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('alerts', () => {
  it('does not duplicate an open alert', async () => {
    const sql = `INSERT INTO sys.alerts (alert_type, severity, dedupe_key) VALUES ('low_stock', 'info', 'item:42')`;
    await inContext(api, () => api.query(sql));
    await expect(attempt(api, sql)).rejects.toMatchObject({ code: '23505' });
  });
});
