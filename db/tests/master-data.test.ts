/**
 * Migration 0009: master data and reason codes, with the M2 decisions 0032 (one price per item
 * with a "price includes VAT" switch, price levels, customer types), 0033 (four fixed VAT
 * categories, owner-only rate changes), 0036 (cash first, credit by permission with a reason)
 * and 0037 (fixed codes, unique phones and TRNs, PNG/JPEG logo, deactivation with a reason).
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  createUser,
  inContext,
  setContext,
  type TestDatabase,
} from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let admin: pg.Client;
let owner: bigint;
let accountant: bigint;
let cashier: bigint;

/** Runs one statement as `userId` (with an optional reason) and commits. */
async function run<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  userId = 1n,
  reason: string | null = null,
): Promise<pg.QueryResult<T>> {
  await api.query('BEGIN');
  try {
    await setContext(api, userId, reason);
    const result = await api.query<T>(sql, params);
    await api.query('COMMIT');
    return result;
  } catch (error) {
    await api.query('ROLLBACK');
    throw error;
  }
}

/** As the database superuser: no grants apply, but every rule and trigger still does. */
const asAdmin = (sql: string, params: unknown[] = []) =>
  inContext(admin, () => admin.query(sql, params));

const rule = (hint: string) => ({ code: 'AP011', hint });
const denied = (hint: string) => ({ code: 'AP012', hint });
const check = { code: '23514' };
const duplicate = { code: '23505' };
const noGrant = { code: '42501' };

const idOf = async (table: string, code: string): Promise<string> =>
  (await api.query<{ id: string }>(`SELECT id FROM ${table} WHERE code = $1`, [code])).rows[0]!.id;

/** Creates an item and returns its id. */
async function item(
  code: string,
  type = 'stock',
  extra: { nameAr?: string; nameEn?: string; unit?: string; category?: string } = {},
): Promise<string> {
  const { rows } = await run<{ id: string }>(
    `INSERT INTO md.items (code, item_type, name_ar, name_en, category_id, unit_id, vat_category_id)
     SELECT $1, $2, $3, $4, c.id, u.id, v.id
       FROM md.item_categories c, md.units u, md.vat_categories v
      WHERE c.code = $5 AND u.code = $6 AND v.code = 'SR'
     RETURNING id`,
    [
      code,
      type,
      extra.nameAr ?? 'صنف',
      extra.nameEn ?? 'Item',
      extra.category ?? 'EQUIP',
      extra.unit ?? 'PCS',
    ],
  );
  return rows[0]!.id;
}

/** Creates a customer (as `userId`) and returns its id and code. */
async function customer(
  fields: Record<string, unknown>,
  userId = 1n,
  reason: string | null = null,
): Promise<{ id: string; code: string }> {
  const columns = Object.keys(fields);
  const { rows } = await run<{ id: string; code: string }>(
    `INSERT INTO md.customers (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, code`,
    Object.values(fields),
    userId,
    reason,
  );
  return rows[0]!;
}

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  admin = await db.connect('superuser');
  owner = await createUser(api, {
    username: 'owner.md',
    roles: ['owner'],
    signInMethod: 'password_totp',
  });
  accountant = await createUser(api, { username: 'acc.md', roles: ['accountant'] });
  cashier = await createUser(api, { username: 'cash.md', roles: ['cashier'] });
});
afterAll(() => db.drop());

describe('seeds', () => {
  it('has the agreed reference data', async () => {
    const count = async (sql: string) =>
      (await api.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`)).rows[0]!.n;
    expect(await count('md.units')).toBe(12);
    expect(await count('md.item_categories')).toBe(5);
    expect(await count('md.cash_denominations')).toBe(11);
    expect(await count('sys.reason_codes')).toBe(33); // 21 from 0009 + 7 stock reasons from 0011 + 5 sales reasons from 0015
    const { rows: lines } = await api.query<{ code: string; rev: string; cogs: string }>(
      `SELECT b.code, r.code AS rev, c.code AS cogs FROM md.business_lines b
         JOIN gl.accounts r ON r.id = b.revenue_account_id JOIN gl.accounts c ON c.id = b.cogs_account_id
        ORDER BY b.sort_order`,
    );
    expect(lines).toEqual([
      { code: 'supplies', rev: '4100', cogs: '5100' },
      { code: 'construction', rev: '4200', cogs: '5200' },
      { code: 'maintenance', rev: '4300', cogs: '5300' },
      { code: 'cleaning', rev: '4400', cogs: '5400' },
    ]);
    const { rows: methods } = await api.query<{ code: string; account: string }>(
      `SELECT p.code, a.code AS account FROM md.payment_methods p
         JOIN gl.accounts a ON a.id = p.gl_account_id ORDER BY p.sort_order`,
    );
    expect(methods).toEqual([
      { code: 'CASH', account: '1110' },
      { code: 'CARD', account: '1150' },
      { code: 'BANK', account: '1140' },
      { code: 'CHEQUE', account: '1160' },
    ]);
    expect(
      (await api.query(`SELECT code FROM md.warehouses WHERE is_default AND is_active`)).rows,
    ).toEqual([{ code: 'MAIN' }]);
    expect(
      (
        await api.query(
          `SELECT code, is_default, customer_types FROM md.price_levels WHERE is_active`,
        )
      ).rows,
    ).toEqual([{ code: 'STANDARD', is_default: true, customer_types: [] }]);
    expect(
      (
        await api.query(
          `SELECT code, name, name_alt, customer_type, credit_mode FROM md.customers WHERE is_walk_in`,
        )
      ).rows,
    ).toEqual([
      {
        code: 'WALK-IN',
        name: 'عميل نقدي',
        name_alt: 'Cash customer',
        customer_type: 'individual',
        credit_mode: 'cash',
      },
    ]);
  });

  it('closes the two links M1 left open', async () => {
    const { rows } = await api.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname IN ('devices_default_warehouse_fk', 'approvals_reason_code_fk') ORDER BY 1`,
    );
    expect(rows.map((r) => r.conname)).toEqual([
      'approvals_reason_code_fk',
      'devices_default_warehouse_fk',
    ]);
  });
});

describe('VAT categories (decision 0033)', () => {
  it('are exactly the four UAE categories', async () => {
    const { rows } = await api.query(
      `SELECT code, rate_bp, einvoice_code FROM md.vat_categories ORDER BY id`,
    );
    expect(rows).toEqual([
      { code: 'SR', rate_bp: 500, einvoice_code: 'S' },
      { code: 'ZR', rate_bp: 0, einvoice_code: 'Z' },
      { code: 'EX', rate_bp: 0, einvoice_code: 'E' },
      { code: 'OS', rate_bp: 0, einvoice_code: 'O' },
    ]);
    await expect(
      run(`INSERT INTO md.vat_categories (code, name_ar, name_en, rate_bp, einvoice_code)
           VALUES ('SR2', 'س', 'X', 1000, 'S')`),
    ).rejects.toMatchObject(noGrant);
    await expect(
      run(`UPDATE md.vat_categories SET is_active = false WHERE code = 'EX'`, [], owner, 'x'),
    ).rejects.toMatchObject(noGrant);
    await expect(
      asAdmin(`UPDATE md.vat_categories SET is_active = false WHERE code = 'EX'`),
    ).rejects.toMatchObject({ code: 'AP003' });
  });

  it('change rate only by the owner, with a reason, and the change is audited', async () => {
    const setRate = (rate: number, userId: bigint, reason: string | null) =>
      run(`UPDATE md.vat_categories SET rate_bp = $1 WHERE code = 'SR'`, [rate], userId, reason);
    await expect(setRate(600, accountant, 'Law changed')).rejects.toMatchObject(
      denied('VAT_RATE_OWNER_ONLY'),
    );
    await expect(setRate(600, owner, null)).rejects.toMatchObject(rule('REASON_REQUIRED'));
    await setRate(600, owner, 'Test of a law change');
    const { rows } = await api.query(
      `SELECT old_values, new_values, reason, user_id::text FROM audit.log
        WHERE entity_type = 'md.vat_categories' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({
      old_values: { rate_bp: 500 },
      new_values: { rate_bp: 600 },
      reason: 'Test of a law change',
      user_id: owner.toString(),
    });
    await setRate(500, owner, 'Back to 5%');
    await expect(setRate(0, owner, 'No')).rejects.toMatchObject(check);
    await expect(
      run(`UPDATE md.vat_categories SET rate_bp = 500 WHERE code = 'ZR'`, [], owner, 'No'),
    ).rejects.toMatchObject(check);
  });
});

describe('items', () => {
  it('keep their code, and are found however Arabic letters are typed', async () => {
    const id = await item('EQ-0001', 'stock', { nameAr: 'مضخة أرضية', nameEn: 'Floor pump' });
    const find = async (text: string) =>
      (
        await api.query<{ id: string }>(
          `SELECT id FROM md.items WHERE search_key LIKE '%' || sys.normalize_search($1) || '%'`,
          [text],
        )
      ).rows.map((r) => r.id);
    expect(await find('مضخه ارضيه')).toEqual([id]);
    expect(await find('FLOOR')).toEqual([id]);
    expect(await find('eq-0001')).toEqual([id]);
    await expect(
      run(`UPDATE md.items SET code = 'EQ-9' WHERE id = $1`, [id]),
    ).rejects.toMatchObject(noGrant);
    await expect(
      asAdmin(`UPDATE md.items SET code = 'EQ-9' WHERE id = $1`, [id]),
    ).rejects.toMatchObject(rule('CODE_FIXED'));
    await expect(item('eq-0001')).rejects.toMatchObject(duplicate);
  });

  it('keep stock settings for stock items, in the unit’s decimals', async () => {
    const id = await idOf('md.items', 'EQ-0001');
    await expect(
      run(`UPDATE md.items SET reorder_level = 1.5 WHERE id = $1`, [id]),
    ).rejects.toMatchObject(rule('QUANTITY_DECIMALS'));
    await run(`UPDATE md.items SET reorder_level = 5, reorder_qty = 10 WHERE id = $1`, [id]);
    const kg = await item('CH-0001', 'stock', { unit: 'KG', category: 'CHEM' });
    await run(`UPDATE md.items SET reorder_level = 2.5 WHERE id = $1`, [kg]);
    const service = await item('SV-0001', 'service', { unit: 'VISIT', category: 'SERV' });
    await expect(
      run(`UPDATE md.items SET reorder_level = 1 WHERE id = $1`, [service]),
    ).rejects.toMatchObject(check);
  });

  it('purchase prices (decision 0038): only the owner sets them; stock and services, never kits', async () => {
    const stock = await item('COST-0001');
    // Without items.cost nobody can set or change a cost, not even the accountant.
    await expect(
      run(`UPDATE md.items SET fallback_unit_cost_4dp = 62000 WHERE id = $1`, [stock], accountant),
    ).rejects.toMatchObject(denied('COST_PERMISSION'));
    await expect(
      run(`UPDATE md.items SET fallback_unit_cost_4dp = 62000 WHERE id = $1`, [stock], cashier),
    ).rejects.toMatchObject(denied('COST_PERMISSION'));
    await run(`UPDATE md.items SET fallback_unit_cost_4dp = 62000 WHERE id = $1`, [stock], owner);
    // Other edits by someone without the permission leave the cost alone and are allowed.
    await run(`UPDATE md.items SET name_en = 'Renamed' WHERE id = $1`, [stock], accountant);
    expect(
      (
        await api.query(`SELECT fallback_unit_cost_4dp::text AS c FROM md.items WHERE id = $1`, [
          stock,
        ])
      ).rows[0],
    ).toEqual({ c: '62000' });
    // A service may have a cost; a kit may not (its cost comes from its components).
    const service = await item('COST-SV01', 'service', { unit: 'VISIT', category: 'SERV' });
    await run(
      `UPDATE md.items SET fallback_unit_cost_4dp = 150000 WHERE id = $1`,
      [service],
      owner,
    );
    const kit = await item('COST-KIT1', 'bundle');
    await expect(
      run(`UPDATE md.items SET fallback_unit_cost_4dp = 1 WHERE id = $1`, [kit], owner),
    ).rejects.toMatchObject(check);
    await expect(
      run(`UPDATE md.items SET fallback_unit_cost_4dp = -1 WHERE id = $1`, [stock], owner),
    ).rejects.toMatchObject(check);
    // A new item with a cost also needs the permission.
    await expect(
      run(
        `INSERT INTO md.items (code, item_type, name_ar, name_en, category_id, unit_id, vat_category_id, fallback_unit_cost_4dp)
         SELECT 'COST-0002', 'stock', 'صنف', 'Item', c.id, u.id, v.id, 5
           FROM md.item_categories c, md.units u, md.vat_categories v
          WHERE c.code = 'EQUIP' AND u.code = 'PCS' AND v.code = 'SR'`,
        [],
        accountant,
      ),
    ).rejects.toMatchObject(denied('COST_PERMISSION'));
    // The change is audited with the old and new value.
    const { rows } = await api.query(
      `SELECT new_values ->> 'fallback_unit_cost_4dp' AS c FROM audit.log
        WHERE entity_type = 'md.items' AND (new_values ->> 'fallback_unit_cost_4dp') = '62000' LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
  });

  it('use only active categories, units and lines of business, which stay active while used', async () => {
    await run(
      `INSERT INTO md.item_categories (code, name_ar, name_en) VALUES ('OLD', 'قديم', 'Old')`,
    );
    await run(
      `UPDATE md.item_categories SET is_active = false WHERE code = 'OLD'`,
      [],
      1n,
      'Not used',
    );
    await expect(item('X-1', 'stock', { category: 'OLD' })).rejects.toMatchObject(
      rule('REFERENCE_INACTIVE'),
    );
    await expect(
      run(`UPDATE md.item_categories SET is_active = false WHERE code = 'EQUIP'`, [], 1n, 'x'),
    ).rejects.toMatchObject(rule('STILL_USED'));
    await expect(
      run(`UPDATE md.units SET is_active = false WHERE code = 'PCS'`, [], 1n, 'x'),
    ).rejects.toMatchObject(rule('STILL_USED'));
    await expect(run(`UPDATE md.units SET decimals = 0 WHERE code = 'KG'`)).rejects.toMatchObject(
      rule('STILL_USED'),
    );
    await run(`UPDATE md.units SET decimals = 1 WHERE code = 'PCS'`);
    await run(`UPDATE md.units SET decimals = 0 WHERE code = 'HR'`);
  });

  it('item categories form a tree without loops', async () => {
    await run(
      `INSERT INTO md.item_categories (parent_id, code, name_ar, name_en)
       SELECT id, 'PUMPS', 'مضخات', 'Pumps' FROM md.item_categories WHERE code = 'EQUIP'`,
    );
    await expect(
      run(
        `UPDATE md.item_categories SET parent_id = (SELECT id FROM md.item_categories WHERE code = 'PUMPS')
          WHERE code = 'EQUIP'`,
      ),
    ).rejects.toMatchObject(rule('CATEGORY_LOOP'));
  });

  it('need a reason to be deactivated', async () => {
    const id = await item('EQ-0002');
    await expect(
      run(`UPDATE md.items SET is_active = false WHERE id = $1`, [id]),
    ).rejects.toMatchObject(rule('REASON_REQUIRED'));
    await run(`UPDATE md.items SET is_active = false WHERE id = $1`, [id], 1n, 'Discontinued');
    const { rows } = await api.query(
      `SELECT reason FROM audit.log WHERE entity_type = 'md.items' AND entity_id = $1 AND action = 'update'`,
      [id],
    );
    expect(rows).toEqual([{ reason: 'Discontinued' }]);
    await expect(api.query(`DELETE FROM md.items WHERE id = $1`, [id])).rejects.toMatchObject(
      noGrant,
    );
  });
});

describe('barcodes', () => {
  const addBarcode = (itemId: string, barcode: string, primary = false, qty = 1) =>
    run(
      `INSERT INTO md.item_barcodes (item_id, barcode, is_primary, qty_per_scan)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [itemId, barcode, primary, qty],
    ).then((r) => (r.rows[0] as { id: string }).id);

  it('belong to one active item, with one primary each', async () => {
    const pump = await idOf('md.items', 'EQ-0001');
    const chlorine = await idOf('md.items', 'CH-0001');
    const first = await addBarcode(pump, '6291234567890', true);
    await addBarcode(pump, 'ap-pump-6', false, 6);
    await expect(addBarcode(chlorine, '6291234567890')).rejects.toMatchObject(duplicate);
    await expect(addBarcode(chlorine, 'AP-PUMP-6')).rejects.toMatchObject(duplicate);
    await expect(addBarcode(pump, '6290000000001', true)).rejects.toMatchObject(duplicate);
    await expect(addBarcode(pump, 'no spaces')).rejects.toMatchObject(check);
    await expect(addBarcode(pump, '6290000000002', false, 1.25)).rejects.toMatchObject(
      rule('QUANTITY_DECIMALS'),
    );
    await expect(
      asAdmin(`UPDATE md.item_barcodes SET item_id = $1 WHERE id = $2`, [chlorine, first]),
    ).rejects.toMatchObject({ code: 'AP003' });
    await run(`UPDATE md.item_barcodes SET is_active = false, is_primary = false WHERE id = $1`, [
      first,
    ]);
    await addBarcode(chlorine, '6291234567890', true);
  });
});

describe('kits (bundles)', () => {
  const addComponent = (kit: string, component: string, quantity: number) =>
    run(
      `INSERT INTO md.bundle_components (bundle_item_id, component_item_id, quantity) VALUES ($1, $2, $3)`,
      [kit, component, quantity],
    );

  it('contain stock items and services, never another kit or themselves', async () => {
    const kit = await item('KIT-0001', 'bundle', { unit: 'SET' });
    const pump = await idOf('md.items', 'EQ-0001');
    const visit = await idOf('md.items', 'SV-0001');
    await addComponent(kit, pump, 1);
    await addComponent(kit, visit, 2);
    const otherKit = await item('KIT-0002', 'bundle', { unit: 'SET' });
    await expect(addComponent(kit, otherKit, 1)).rejects.toMatchObject(rule('KIT_RULE'));
    await expect(addComponent(pump, visit, 1)).rejects.toMatchObject(rule('KIT_RULE'));
    await expect(addComponent(kit, kit, 1)).rejects.toMatchObject(rule('KIT_RULE'));
    const chlorine = await idOf('md.items', 'CH-0001');
    await addComponent(kit, chlorine, 2.5);
  });

  it('fix the type of their items, and keep their components active', async () => {
    const kit = await idOf('md.items', 'KIT-0001');
    const pump = await idOf('md.items', 'EQ-0001');
    await expect(
      run(
        `UPDATE md.items SET item_type = 'service', reorder_level = NULL, reorder_qty = NULL WHERE id = $1`,
        [pump],
      ),
    ).rejects.toMatchObject({ ...rule('ITEM_TYPE_FIXED'), detail: 'kit_component' });
    await expect(
      run(`UPDATE md.items SET item_type = 'stock' WHERE id = $1`, [kit]),
    ).rejects.toMatchObject({ ...rule('ITEM_TYPE_FIXED'), detail: 'kit_contents' });
    await expect(
      run(`UPDATE md.items SET is_active = false WHERE id = $1`, [pump], 1n, 'Old model'),
    ).rejects.toMatchObject(rule('ITEM_IN_ACTIVE_KIT'));
    const unused = await idOf('md.items', 'KIT-0002');
    await run(`UPDATE md.items SET item_type = 'service' WHERE id = $1`, [unused]);
  });

  it('can lose a component, which is audited', async () => {
    const kit = await idOf('md.items', 'KIT-0001');
    const chlorine = await idOf('md.items', 'CH-0001');
    await run(
      `DELETE FROM md.bundle_components WHERE bundle_item_id = $1 AND component_item_id = $2`,
      [kit, chlorine],
    );
    const { rows } = await api.query(
      `SELECT action FROM audit.log WHERE entity_type = 'md.bundle_components' AND entity_id = $1
        ORDER BY id`,
      [`${kit}:${chlorine}`],
    );
    expect(rows).toEqual([{ action: 'insert' }, { action: 'delete' }]);
  });
});

describe('prices (decision 0032)', () => {
  const setPrice = (itemId: string, price: number, includesVat: boolean, level = 'STANDARD') =>
    run(
      `INSERT INTO md.item_prices (price_level_id, item_id, price_4dp, includes_vat)
       SELECT id, $2, $3, $4 FROM md.price_levels WHERE code = $1 RETURNING id`,
      [level, itemId, price, includesVat],
    );

  it('one price per item and level, at 4 decimals, with its own "includes VAT" switch', async () => {
    const pump = await idOf('md.items', 'EQ-0001');
    await setPrice(pump, 1_250_000, true);
    await expect(setPrice(pump, 1_000_000, false)).rejects.toMatchObject(duplicate);
    await expect(setPrice(await idOf('md.items', 'CH-0001'), -1, false)).rejects.toMatchObject(
      check,
    );
    await run(
      `UPDATE md.item_prices SET price_4dp = 1299999, includes_vat = false WHERE item_id = $1`,
      [pump],
    );
    await expect(
      asAdmin(`UPDATE md.item_prices SET item_id = $1 WHERE item_id = $2`, [
        await idOf('md.items', 'CH-0001'),
        pump,
      ]),
    ).rejects.toMatchObject({ code: 'AP003' });
  });

  it('a later price level can serve chosen customer types; only one level per type', async () => {
    await expect(
      run(`INSERT INTO md.price_levels (code, name_ar, name_en) VALUES ('X', 'س', 'X')`),
    ).rejects.toMatchObject(noGrant);
    await asAdmin(
      `INSERT INTO md.price_levels (code, name_ar, name_en, customer_types)
       VALUES ('TRADE', 'سعر المقاولين', 'Contractors & companies', '{contractor,company}')`,
    );
    await expect(
      asAdmin(
        `INSERT INTO md.price_levels (code, name_ar, name_en, customer_types)
         VALUES ('TRADE2', 'س', 'X', '{company}')`,
      ),
    ).rejects.toMatchObject(rule('PRICE_LEVEL_TYPE_TAKEN'));
    await expect(
      asAdmin(`UPDATE md.price_levels SET is_default = false WHERE code = 'STANDARD'`),
    ).rejects.toMatchObject(rule('DEFAULT_REQUIRED'));
    await expect(
      asAdmin(`UPDATE md.price_levels SET customer_types = '{individual}' WHERE code = 'STANDARD'`),
    ).rejects.toMatchObject(check);
    await expect(
      asAdmin(`UPDATE md.price_levels SET customer_types = '{shop}' WHERE code = 'TRADE'`),
    ).rejects.toMatchObject(check);
    await setPrice(await idOf('md.items', 'EQ-0001'), 1_100_000, false, 'TRADE');
  });
});

describe('customers', () => {
  it('get a code, a type and a unique phone; the TRN follows VAT registration', async () => {
    const first = await customer({
      customer_type: 'company',
      name: 'فندق العين',
      phone: '+971501234567',
    });
    expect(first.code).toMatch(/^C\d{5}$/);
    await expect(
      customer({ customer_type: 'shop', name: 'X', phone: '+971501111111' }),
    ).rejects.toMatchObject(check);
    await expect(customer({ customer_type: 'individual', name: 'X' })).rejects.toMatchObject(check);
    await expect(
      customer({ customer_type: 'individual', name: 'X', phone: '+971501234567' }),
    ).rejects.toMatchObject(duplicate);
    await expect(
      customer({ customer_type: 'individual', name: 'X', phone: '0501111111' }),
    ).rejects.toMatchObject(check);
    const vat = { customer_type: 'company', name: 'Contractor LLC', phone: '+971502222222' };
    await expect(customer({ ...vat, is_vat_registered: true })).rejects.toMatchObject(check);
    await expect(
      customer({ ...vat, is_vat_registered: true, trn: '200123456789012' }),
    ).rejects.toMatchObject(check);
    await expect(customer({ ...vat, trn: '100123456789012' })).rejects.toMatchObject(check);
    await customer({ ...vat, is_vat_registered: true, trn: '100123456789012' });
    await expect(
      customer({
        customer_type: 'company',
        name: 'Same TRN',
        phone: '+971503333333',
        is_vat_registered: true,
        trn: '100123456789012',
      }),
    ).rejects.toMatchObject(duplicate);
  });

  it('are found by name variants, by local phone number and by TRN', async () => {
    const find = async (text: string) =>
      (
        await api.query<{ name: string }>(
          `SELECT name FROM md.customers WHERE search_key LIKE '%' || sys.normalize_search($1) || '%'`,
          [text],
        )
      ).rows.map((r) => r.name);
    expect(await find('فندق العين')).toEqual(['فندق العين']);
    expect(await find('0501234567')).toEqual(['فندق العين']);
    expect(await find('100123456789012')).toEqual(['Contractor LLC']);
  });

  it('start as cash; credit needs customers.credit and a reason (decision 0036)', async () => {
    const base = { customer_type: 'contractor', name: 'Builder', phone: '+971504444444' };
    const credit = { credit_mode: 'credit', credit_limit_fils: 500_000, payment_terms_days: 30 };
    await expect(customer({ ...base, ...credit }, cashier, 'Good customer')).rejects.toMatchObject(
      denied('CREDIT_PERMISSION'),
    );
    await expect(customer({ ...base, ...credit }, accountant, null)).rejects.toMatchObject(
      rule('REASON_REQUIRED'),
    );
    const { id } = await customer(base, cashier);
    const giveCredit = (userId: bigint, reason: string | null, limit = 500_000) =>
      run(
        `UPDATE md.customers SET credit_mode = 'credit', credit_limit_fils = $2, payment_terms_days = 30
          WHERE id = $1`,
        [id, limit],
        userId,
        reason,
      );
    await expect(giveCredit(cashier, 'Trusted')).rejects.toMatchObject(denied('CREDIT_PERMISSION'));
    await expect(giveCredit(accountant, null)).rejects.toMatchObject(rule('REASON_REQUIRED'));
    await expect(giveCredit(accountant, 'Trusted', 0)).rejects.toMatchObject(check);
    await giveCredit(accountant, 'Trusted contractor for 5 years');
    const { rows } = await api.query(
      `SELECT new_values, reason FROM audit.log
        WHERE entity_type = 'md.customers' AND entity_id = $1 AND action = 'update'`,
      [id],
    );
    expect(rows).toEqual([
      {
        new_values: { credit_mode: 'credit', credit_limit_fils: 500000, payment_terms_days: 30 },
        reason: 'Trusted contractor for 5 years',
      },
    ]);
    // Other details stay editable by the cashier; the credit fields do not move.
    await run(`UPDATE md.customers SET email = 'b@example.com' WHERE id = $1`, [id], cashier);
    await expect(
      run(
        `UPDATE md.customers SET credit_mode = 'cash', credit_limit_fils = 0, payment_terms_days = 0
          WHERE id = $1`,
        [id],
        cashier,
        'x',
      ),
    ).rejects.toMatchObject(denied('CREDIT_PERMISSION'));
    await expect(
      run(
        `UPDATE md.customers SET credit_limit_fils = 100 WHERE phone = '+971501234567'`,
        [],
        owner,
        'A cash customer has no limit',
      ),
    ).rejects.toMatchObject(check);
  });

  it('keep the walk-in "Cash customer" unique and unchangeable', async () => {
    await expect(
      run(`UPDATE md.customers SET name = 'X' WHERE is_walk_in`, [], owner),
    ).rejects.toMatchObject(rule('WALK_IN_LOCKED'));
    await expect(
      run(`UPDATE md.customers SET is_active = false WHERE is_walk_in`, [], owner, 'x'),
    ).rejects.toMatchObject(rule('WALK_IN_LOCKED'));
    await expect(
      customer({ customer_type: 'individual', name: 'X', is_walk_in: true }),
    ).rejects.toMatchObject(noGrant);
    await expect(
      asAdmin(
        `INSERT INTO md.customers (customer_type, name, is_walk_in) VALUES ('individual', 'X', true)`,
      ),
    ).rejects.toMatchObject(duplicate);
  });
});

describe('suppliers, payment methods, warehouses, reason codes, lines of business', () => {
  it('suppliers get a code, and their TRN follows VAT registration', async () => {
    const { rows } = await run<{ code: string }>(
      `INSERT INTO md.suppliers (name, is_vat_registered, trn) VALUES ('Pool Chem Trading', true, '100999999999999')
       RETURNING code`,
    );
    expect(rows[0]!.code).toMatch(/^S\d{5}$/);
    await expect(
      run(`INSERT INTO md.suppliers (name, is_vat_registered) VALUES ('X', true)`),
    ).rejects.toMatchObject(check);
    await expect(
      run(
        `INSERT INTO md.suppliers (name, is_vat_registered, trn) VALUES ('Y', true, '100999999999999')`,
      ),
    ).rejects.toMatchObject(duplicate);
  });

  it('payment methods post to an active asset account, and only cash gives change', async () => {
    const insert = (kind: string, account: string, givesChange = false) =>
      run(
        `INSERT INTO md.payment_methods (code, name_ar, name_en, kind, gl_account_id, gives_change)
         SELECT 'PM-' || $1, 'طريقة', 'Method', $1, id, $3 FROM gl.accounts WHERE code = $2`,
        [kind, account, givesChange],
      );
    await expect(insert('other', '4100')).rejects.toMatchObject(rule('PAYMENT_ACCOUNT_INVALID'));
    await expect(insert('other', '1100')).rejects.toMatchObject(rule('PAYMENT_ACCOUNT_INVALID'));
    await expect(insert('other', '1210')).rejects.toMatchObject(rule('PAYMENT_ACCOUNT_INVALID'));
    await expect(insert('card', '1150', true)).rejects.toMatchObject(check);
    await insert('other', '1130');
    await expect(
      run(`UPDATE gl.accounts SET is_active = false WHERE code = '1130'`, [], 1n, 'x'),
    ).rejects.toMatchObject({ ...rule('ACCOUNT_IN_USE'), detail: 'payment_method' });
  });

  it('lines of business use a revenue and a cost-of-sales account, which stay in use', async () => {
    await expect(
      run(
        `INSERT INTO md.business_lines (code, name_ar, name_en, revenue_account_id, cogs_account_id)
         SELECT 'repairs', 'إصلاحات', 'Repairs', c.id, c.id FROM gl.accounts c WHERE c.code = '5100'`,
      ),
    ).rejects.toMatchObject(rule('BUSINESS_LINE_ACCOUNT_INVALID'));
    await expect(
      run(`UPDATE gl.accounts SET is_active = false WHERE code = '4400'`, [], 1n, 'x'),
    ).rejects.toMatchObject({ ...rule('ACCOUNT_IN_USE'), detail: 'business_line' });
  });

  it('warehouses: one default per branch that moves when another is chosen; vans need a technician', async () => {
    const add = (code: string, type = 'store', isDefault = false) =>
      run(
        `INSERT INTO md.warehouses (code, name_ar, name_en, branch_id, warehouse_type, is_default)
         SELECT $1, 'مخزن', 'Store', id, $2, $3 FROM sys.branches WHERE code = 'HQ'`,
        [code, type, isDefault],
      );
    await expect(add('VAN-1', 'van')).rejects.toMatchObject(check);
    await add('SHOP-2', 'store', true);
    const defaults = async () =>
      (await api.query<{ code: string }>(`SELECT code FROM md.warehouses WHERE is_default`)).rows;
    expect(await defaults()).toEqual([{ code: 'SHOP-2' }]);
    await expect(
      run(`UPDATE md.warehouses SET is_default = false WHERE code = 'SHOP-2'`),
    ).rejects.toMatchObject(rule('DEFAULT_REQUIRED'));
    await run(`UPDATE md.warehouses SET is_default = true WHERE code = 'MAIN'`);
    expect(await defaults()).toEqual([{ code: 'MAIN' }]);
  });

  it('reason codes: paid-in and paid-out reasons carry an account; others never do', async () => {
    const add = (category: string, account: string | null) =>
      run(
        `INSERT INTO sys.reason_codes (category, code, name_ar, name_en, gl_account_id)
         VALUES ($1, 'T-' || $1, 'سبب', 'Reason', (SELECT id FROM gl.accounts WHERE code = $2))`,
        [category, account],
      );
    await expect(add('paid_out', null)).rejects.toMatchObject(check);
    await expect(add('stock_decrease', '6900')).rejects.toMatchObject(check);
    await expect(add('paid_out', '6000')).rejects.toMatchObject(rule('REASON_ACCOUNT_INVALID'));
    await add('paid_out', '6500');
    await expect(add('paid_out', '6500')).rejects.toMatchObject(duplicate);
  });
});

describe('company details (decision 0037)', () => {
  const save = (trn: string | null, mime: string | null) =>
    run(
      `INSERT INTO sys.company_profile (id, legal_name_ar, legal_name_en, vat_registered, trn,
                                        address_ar, address_en, logo, logo_mime)
       VALUES (1, 'آرتي بول', 'ARTEPOOL', $1::text IS NOT NULL, $1, 'العين', 'Al Ain',
               CASE WHEN $2::text IS NULL THEN NULL ELSE '\\x89504e47'::bytea END, $2)`,
      [trn, mime],
      owner,
    );

  it('need a TRN starting with 100 and a PNG or JPEG logo', async () => {
    await expect(save('200123456789012', null)).rejects.toMatchObject(check);
    await expect(save('100123456789012', 'image/svg+xml')).rejects.toMatchObject(check);
    await save('100123456789012', 'image/png');
  });
});
