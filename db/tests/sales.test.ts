/**
 * Migration 0015: sales. The database works out every line, numbers documents at issue without
 * gaps, picks the invoice format from the customer's VAT registration, freezes issued documents,
 * keeps advance deductions within what remains (the 0013 example reproduces exactly), allocates
 * every payment in full, refuses unpaid credit beyond the customer's limit, and requires the
 * journal entry and stock movements in the same transaction.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDevice,
  createTestDatabase,
  createUser,
  setContext,
  type TestDatabase,
} from '@artepool/testing';

let db: TestDatabase;
let api: pg.Client;
let owner: bigint;
let accountant: bigint;
let cashier: bigint;
let device: bigint;
let today: string;
const r: Record<string, string> = {};
let phoneNo = 5_000_000;

const rule = (hint: string) => ({ code: 'AP011', hint });
const denied = (hint: string) => ({ code: 'AP012', hint });

async function tx<T>(
  work: (c: pg.Client) => Promise<T>,
  userId: bigint = owner,
  reason: string | null = null,
): Promise<T> {
  await api.query('BEGIN');
  try {
    await setContext(api, userId, reason, device);
    const result = await work(api);
    await api.query('COMMIT');
    return result;
  } catch (error) {
    await api.query('ROLLBACK');
    throw error;
  }
}

const one = async <T extends pg.QueryResultRow>(
  c: pg.Client,
  sql: string,
  params: unknown[] = [],
) => (await c.query<T>(sql, params)).rows[0]!;

async function customer(
  name: string,
  opts: { trn?: string; creditLimit?: number; address?: string | null } = {},
): Promise<string> {
  phoneNo += 1;
  const credit = opts.creditLimit !== undefined;
  return tx(
    async (c) =>
      (
        await one<{ id: string }>(
          c,
          `INSERT INTO md.customers (code, customer_type, name, phone, is_vat_registered, trn, credit_mode,
                                   credit_limit_fils, payment_terms_days, address_line)
         VALUES ($1, 'company', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            `C${phoneNo}`,
            name,
            `+97150${phoneNo}`,
            opts.trn !== undefined,
            opts.trn ?? null,
            credit ? 'credit' : 'cash',
            opts.creditLimit ?? 0,
            credit ? 30 : 0,
            // An A4 invoice is a full tax invoice and needs the address (0064, 0071).
            opts.address !== undefined ? opts.address : 'Industrial Area',
          ],
        )
      ).id,
    owner,
    'Customer for the sales tests',
  );
}

async function item(code: string, type: 'service' | 'stock', price: number, includesVat: boolean) {
  return tx(async (c) => {
    const i = await one<{ id: string }>(
      c,
      `INSERT INTO md.items (code, item_type, name_ar, name_en, category_id, unit_id, vat_category_id)
       VALUES ($1, $2, 'صنف', 'Item', $3, (SELECT id FROM md.units WHERE code = $4), $5) RETURNING id`,
      [code, type, r.category, type === 'service' ? 'VISIT' : 'PCS', r.vat],
    );
    await c.query(
      `INSERT INTO md.item_prices (price_level_id, item_id, price_4dp, includes_vat) VALUES ($1, $2, $3, $4)`,
      [r.level, i.id, price, includesVat],
    );
    return i.id;
  });
}

/** A draft document; returns its id. */
const draft = (
  c: pg.Client,
  type: string,
  customerId: string,
  extra: { original?: string; reason?: string; channel?: string; shift?: string } = {},
) =>
  one<{ id: string }>(
    c,
    `INSERT INTO sales.documents (doc_type, channel, branch_id, business_line_id, warehouse_id, device_id, customer_id,
                                  bill_to_name, original_document_id, reason_code_id, reason_text, shift_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Bill to', $8, $9, $10, $11) RETURNING id`,
    [
      type,
      extra.channel ?? 'office',
      r.branch,
      r.line,
      r.warehouse,
      device,
      customerId,
      extra.original ?? null,
      extra.reason ?? null,
      extra.reason ? 'Because' : null,
      extra.shift ?? null,
    ],
  ).then((d) => d.id);

interface LineIn {
  kind?: 'item' | 'advance' | 'advance_deduction';
  item?: string;
  qty?: string;
  price: number;
  lineDiscount?: number;
  advanceDoc?: string;
  net?: number;
  vat?: number;
  originalLine?: string;
  returnStatus?: string;
}

let lineNo = 0;
const line = (c: pg.Client, doc: string, l: LineIn) => {
  lineNo += 1;
  return one<{ id: string; net_fils: string; vat_fils: string; gross_fils: string }>(
    c,
    `INSERT INTO sales.document_lines (document_id, line_no, line_kind, item_id, description_ar, description_en,
                                       business_line_id, quantity, unit_price_4dp, line_discount_fils, vat_category_id,
                                       net_fils, vat_fils, gross_fils, advance_document_id, original_line_id,
                                       return_stock_status)
     VALUES ($1, $2, $3, $4, 'بند', 'Line', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id, net_fils::text, vat_fils::text, gross_fils::text`,
    [
      doc,
      lineNo,
      l.kind ?? 'item',
      l.item ?? null,
      r.line,
      l.qty ?? '1',
      l.price,
      l.lineDiscount ?? 0,
      r.vat,
      l.net ?? 0,
      l.vat ?? 0,
      (l.net ?? 0) + (l.vat ?? 0),
      l.advanceDoc ?? null,
      l.originalLine ?? null,
      l.returnStatus ?? null,
    ],
  );
};

/** A balanced journal entry for a source (receivable / VAT payable: the accounts do not matter here). */
async function journal(
  c: pg.Client,
  source: 'sales_document' | 'payment' | 'opening_balance',
  id: string,
  customerId: string,
) {
  const column = {
    sales_document: 'sales_document_id',
    payment: 'payment_id',
    opening_balance: 'opening_balance_id',
  }[source];
  const e = await one<{ id: string }>(
    c,
    `INSERT INTO gl.journal_entries (entry_date, source_type, ${column}, total_debit_fils, total_credit_fils)
     VALUES ($1, $2, $3, 100, 100) RETURNING id`,
    [today, source, id],
  );
  await c.query(
    `INSERT INTO gl.journal_lines (entry_id, line_no, account_id, debit_fils, credit_fils, customer_id)
     VALUES ($1, 1, $2, 100, 0, $4), ($1, 2, $3, 0, 100, NULL)`,
    [e.id, r.ar, r.vatOut, customerId],
  );
}

const issue = async (c: pg.Client, doc: string, customerId: string) => {
  const d = await one<{
    doc_number: string;
    total_fils: string;
    vat_fils: string;
    invoice_format: string;
  }>(
    c,
    `UPDATE sales.documents SET status = 'issued', content_hash = '\\x01' WHERE id = $1
     RETURNING doc_number, total_fils::text, vat_fils::text, invoice_format`,
    [doc],
  );
  await journal(c, 'sales_document', doc, customerId);
  return d;
};

/** Receives a payment and allocates it; the allocations must cover it (checked at commit). */
async function receive(
  c: pg.Client,
  customerId: string,
  amount: number,
  allocations: { doc?: string; opening?: string; amount: number }[],
  kind: 'receipt' | 'refund' = 'receipt',
) {
  const p = await one<{ id: string; doc_number: string }>(
    c,
    `INSERT INTO sales.payments (payment_kind, customer_id, payment_method_id, amount_fils, payment_date, channel, device_id)
     VALUES ($1, $2, $3, $4, $5, 'office', $6) RETURNING id, doc_number`,
    [kind, customerId, r.cash, amount, today, device],
  );
  for (const a of allocations) {
    await c.query(
      `INSERT INTO sales.payment_allocations (payment_id, document_id, opening_balance_id, amount_fils)
       VALUES ($1, $2, $3, $4)`,
      [p.id, a.doc ?? null, a.opening ?? null, a.amount],
    );
  }
  await journal(c, 'payment', p.id, customerId);
  return p;
}

beforeAll(async () => {
  db = await createTestDatabase();
  api = await db.connect('api');
  owner = await createUser(api, {
    username: 'owner.sales',
    roles: ['owner'],
    signInMethod: 'password_totp',
  });
  accountant = await createUser(api, {
    username: 'acc.sales',
    roles: ['accountant'],
    withPin: true,
  });
  cashier = await createUser(api, { username: 'cash.sales', roles: ['cashier'] });
  device = await createDevice(api, { code: 'OFFICE-SALES' });
  today = (await one<{ d: string }>(api, `SELECT sys.business_date()::text AS d`)).d;
  Object.assign(
    r,
    await one<Record<string, string>>(
      api,
      `SELECT (SELECT id::text FROM sys.branches ORDER BY id LIMIT 1) AS branch,
              (SELECT id::text FROM md.business_lines ORDER BY id LIMIT 1) AS line,
              (SELECT id::text FROM md.warehouses WHERE code = 'MAIN') AS warehouse,
              (SELECT id::text FROM md.vat_categories WHERE code = 'SR') AS vat,
              (SELECT id::text FROM md.price_levels WHERE is_default) AS level,
              (SELECT id::text FROM md.item_categories WHERE code = 'EQUIP') AS category,
              (SELECT id::text FROM md.payment_methods WHERE kind = 'cash' ORDER BY id LIMIT 1) AS cash,
              (SELECT account_id::text FROM gl.account_mappings WHERE key = 'ar_control') AS ar,
              (SELECT account_id::text FROM gl.account_mappings WHERE key = 'vat_output') AS "vatOut",
              (SELECT id::text FROM sys.reason_codes WHERE category = 'credit_note' AND code = 'RETURN') AS "cnReturn",
              (SELECT id::text FROM sys.reason_codes WHERE category = 'credit_note' AND code = 'CANCELLED_WORK') AS "cnCancel",
              (SELECT id::text FROM sys.reason_codes WHERE category = 'payment_reversal' AND code = 'BOUNCED') AS bounced`,
    ),
  );
  await tx((c) =>
    c.query(
      `INSERT INTO sys.company_profile (id, legal_name_ar, legal_name_en, address_ar, address_en, vat_registered, trn)
       VALUES (1, 'آرتيبول', 'ARTEPOOL', 'العين', 'Al Ain', true, '100000000000003')`,
    ),
  );
});
afterAll(() => db.drop());

describe('lines and totals (decisions 0009, 0012)', () => {
  it('the database works out each line: an exclusive price gets VAT added, an inclusive one is split', async () => {
    const cust = await customer('Line test');
    const excl = await item('S-EXCL', 'service', 1_000_000, false); // 100.00 + VAT
    const incl = await item('S-INCL', 'service', 99_900, true); // 9.99 incl. VAT
    await tx(async (c) => {
      const doc = await draft(c, 'invoice', cust);
      // The request's amounts are ignored: 999 is not what the line is worth.
      const a = await line(c, doc, {
        item: excl,
        qty: '2',
        price: 1_000_000,
        lineDiscount: 1_000,
        net: 999,
      });
      expect(a).toMatchObject({ net_fils: '19000', vat_fils: '950', gross_fils: '19950' });
      const b = await line(c, doc, { item: incl, qty: '1', price: 99_900 });
      expect(b).toMatchObject({ net_fils: '951', vat_fils: '48', gross_fils: '999' });
      await c.query(`UPDATE sales.documents SET notes = 'touch' WHERE id = $1`, [doc]);
      const d = await one<{
        net_fils: string;
        vat_fils: string;
        total_fils: string;
        discount_total_fils: string;
      }>(
        c,
        `SELECT net_fils::text, vat_fils::text, total_fils::text, discount_total_fils::text FROM sales.documents WHERE id = $1`,
        [doc],
      );
      expect(d).toEqual({
        net_fils: '19951',
        vat_fils: '998',
        total_fils: '20949',
        discount_total_fils: '1000',
      });
      await c.query(`UPDATE sales.documents SET status = 'discarded' WHERE id = $1`, [doc]);
    });
  });
});

describe('issue (decisions 0010, 0011)', () => {
  it('numbers at issue without gaps; INV- in the office; a draft has no number', async () => {
    const cust = await customer('Numbering', { creditLimit: 10_000_000 });
    const svc = await item('S-NUM', 'service', 1_000_000, false);
    const first = await tx(async (c) => {
      const doc = await draft(c, 'invoice', cust);
      await line(c, doc, { item: svc, price: 1_000_000 });
      const before = await one<{ doc_number: string | null }>(
        c,
        `SELECT doc_number FROM sales.documents WHERE id = $1`,
        [doc],
      );
      expect(before.doc_number).toBeNull();
      return issue(c, doc, cust);
    });
    expect(first.doc_number).toMatch(/^INV-/);
    // A failed issue uses no number.
    await expect(
      tx(async (c) => {
        const doc = await draft(c, 'invoice', cust);
        await line(c, doc, { item: svc, price: 1_000_000 });
        await c.query(
          `UPDATE sales.documents SET status = 'issued', content_hash = '\\x01' WHERE id = $1`,
          [doc],
        );
        // no journal entry → refused at commit
      }),
    ).rejects.toMatchObject(rule('JOURNAL_MISSING'));
    const second = await tx(async (c) => {
      const doc = await draft(c, 'invoice', cust);
      await line(c, doc, { item: svc, price: 1_000_000 });
      return issue(c, doc, cust);
    });
    const n = (s: string) => Number(s.replace(/\D/g, ''));
    expect(n(second.doc_number)).toBe(n(first.doc_number) + 1);
  });

  it('a full tax invoice exactly for a VAT-registered customer, with its TRN; issued documents never change', async () => {
    const registered = await customer('Registered', {
      trn: '100123456700003',
      creditLimit: 10_000_000,
    });
    const plain = await customer('Plain', { creditLimit: 10_000_000 });
    const svc = await item('S-FMT', 'service', 1_000_000, false);
    const issueFor = (cust: string) =>
      tx(async (c) => {
        const doc = await draft(c, 'invoice', cust);
        await line(c, doc, { item: svc, price: 1_000_000 });
        const d = await issue(c, doc, cust);
        return { doc, ...d };
      });
    const full = await issueFor(registered);
    expect(full.invoice_format).toBe('full');
    expect(
      (
        await one<{ t: string }>(
          api,
          `SELECT bill_to_trn AS t FROM sales.documents WHERE id = $1`,
          [full.doc],
        )
      ).t,
    ).toBe('100123456700003');
    // An A4 invoice is a full tax invoice for every customer, without a TRN when unregistered (0071).
    const a4 = await issueFor(plain);
    expect(a4.invoice_format).toBe('full');
    await expect(
      tx((c) => c.query(`UPDATE sales.documents SET notes = 'changed' WHERE id = $1`, [full.doc])),
    ).rejects.toMatchObject({ code: 'AP003' });
    await expect(tx((c) => line(c, full.doc, { item: svc, price: 1 }))).rejects.toMatchObject({
      code: 'AP006',
    });
  });

  it('a full tax invoice needs the customer’s address, taken from the customer at issue (0064)', async () => {
    const noAddress = await customer('No address', {
      trn: '100777888900003',
      creditLimit: 10_000_000,
      address: null,
    });
    const svc = await item('S-ADDR', 'service', 1_000_000, false);
    const draftFor = (cust: string) =>
      tx(async (c) => {
        const doc = await draft(c, 'invoice', cust);
        await line(c, doc, { item: svc, price: 1_000_000 });
        return doc;
      });
    const doc = await draftFor(noAddress);
    await expect(tx((c) => issue(c, doc, noAddress))).rejects.toMatchObject(
      rule('FULL_INVOICE_ADDRESS'),
    );
    // The address added to the customer later is printed on the invoice (the draft had none).
    await tx(
      (c) =>
        c.query(`UPDATE md.customers SET address_line = 'Sanaiya', city = 'Al Ain' WHERE id = $1`, [
          noAddress,
        ]),
      owner,
      'Address added',
    );
    await tx((c) => issue(c, doc, noAddress));
    expect(
      (
        await one<{ a: string }>(
          api,
          `SELECT bill_to_address AS a FROM sales.documents WHERE id = $1`,
          [doc],
        )
      ).a,
    ).toBe('Sanaiya، Al Ain');
    // An unregistered customer without an address: a simplified invoice, issued (0071).
    const plain = await customer('Plain, no address', { creditLimit: 10_000_000, address: null });
    const a4 = await draftFor(plain);
    expect((await tx((c) => issue(c, a4, plain))).invoice_format).toBe('simplified');
  });

  it('the walk-in cash customer on an A4 invoice: a simplified invoice, nothing to type (0071)', async () => {
    const walkIn = await one<{ id: string }>(
      api,
      `SELECT id::text FROM md.customers WHERE is_walk_in`,
    );
    const svc = await item('S-WALK', 'service', 1_000_000, false);
    const doc = await tx(async (c) => {
      const d = await draft(c, 'invoice', walkIn.id);
      await line(c, d, { item: svc, price: 1_000_000 });
      return d;
    });
    expect((await tx((c) => issue(c, doc, walkIn.id))).invoice_format).toBe('simplified');
  });

  it('a POS document needs an open shift of its own cashier; an office one never uses POS-', async () => {
    const cust = await customer('POS', { creditLimit: 10_000_000 });
    await expect(tx((c) => draft(c, 'invoice', cust, { channel: 'pos' }))).rejects.toBeTruthy();
    await expect(
      tx((c) => draft(c, 'advance_invoice', cust, { channel: 'pos' })),
    ).rejects.toBeTruthy();
  });
});

describe('credit (decision 0046)', () => {
  it('an unpaid invoice for a cash customer is refused, unless paid at issue or approved', async () => {
    const cust = await customer('Cash only');
    const svc = await item('S-CRED', 'service', 1_000_000, false); // 105.00 with VAT
    const make = (c: pg.Client) =>
      draft(c, 'invoice', cust).then(async (doc) => {
        await line(c, doc, { item: svc, price: 1_000_000 });
        return doc;
      });
    // (The cashier issues: the owner holds sales.credit_over_limit and needs no approval.)
    await expect(
      tx(async (c) => {
        const doc = await make(c);
        await issue(c, doc, cust);
      }, cashier),
    ).rejects.toMatchObject(denied('CREDIT_LIMIT'));
    // Paid in full in the same transaction: fine.
    await tx(async (c) => {
      const doc = await make(c);
      await issue(c, doc, cust);
      await receive(c, cust, 10_500, [{ doc, amount: 10_500 }]);
    });
    // With a supervisor's approval: fine.
    await tx(async (c) => {
      const approval = await one<{ id: string }>(
        c,
        `INSERT INTO auth.approvals (permission_code, approved_by, reason_text)
         VALUES ('sales.credit_over_limit', $1, 'Known customer') RETURNING id`,
        [accountant],
      );
      const doc = await make(c);
      await c.query(`UPDATE sales.documents SET credit_approval_id = $2 WHERE id = $1`, [
        doc,
        approval.id,
      ]);
      await issue(c, doc, cust);
    }, cashier);
  });
});

describe('advance and progress payments (decision 0013)', () => {
  it('the worked example: 31,500 + 42,000, then the final invoice deducts both: 31,500 due, VAT 1,500', async () => {
    const cust = await customer('Pool owner', { creditLimit: 100_000_000 });
    const pool = await item('S-POOL', 'service', 1_000_000_000, false); // 100,000.00 + VAT
    const advance = (amount: number) =>
      tx(async (c) => {
        const doc = await draft(c, 'advance_invoice', cust);
        await line(c, doc, { kind: 'advance', price: amount * 100 });
        const d = await issue(c, doc, cust);
        await receive(c, cust, amount, [{ doc, amount }]);
        return { doc, ...d };
      });
    const a1 = await advance(3_150_000);
    expect(a1).toMatchObject({ total_fils: '3150000', vat_fils: '150000' });
    const a2 = await advance(4_200_000);
    expect(a2).toMatchObject({ total_fils: '4200000', vat_fils: '200000' });

    const final = await tx(async (c) => {
      const doc = await draft(c, 'invoice', cust);
      await line(c, doc, { item: pool, price: 1_000_000_000 });
      await line(c, doc, {
        kind: 'advance_deduction',
        price: -31_500_0000,
        advanceDoc: a1.doc,
        net: -3_000_000,
        vat: -150_000,
      });
      await line(c, doc, {
        kind: 'advance_deduction',
        price: -42_000_0000,
        advanceDoc: a2.doc,
        net: -4_000_000,
        vat: -200_000,
      });
      return issue(c, doc, cust);
    });
    expect(final).toMatchObject({ total_fils: '3150000', vat_fils: '150000' });
    const vat = await one<{ v: string }>(
      api,
      `SELECT sum(vat_fils)::text AS v FROM sales.documents WHERE customer_id = $1 AND status = 'issued'`,
      [cust],
    );
    expect(vat.v).toBe('500000'); // 1,500 + 2,000 + 1,500 = 5,000.00 exactly once

    // Nothing is left to deduct; another customer can never deduct it.
    await expect(
      tx(async (c) => {
        const doc = await draft(c, 'invoice', cust);
        await line(c, doc, { item: pool, price: 1_000_000_000 });
        await line(c, doc, {
          kind: 'advance_deduction',
          price: -1,
          advanceDoc: a1.doc,
          net: -100,
          vat: 0,
        });
        await issue(c, doc, cust);
      }),
    ).rejects.toMatchObject(rule('ADVANCE_DEDUCTION'));
    const other = await customer('Neighbour', { creditLimit: 100_000_000 });
    await expect(
      tx(async (c) => {
        const doc = await draft(c, 'invoice', other);
        await line(c, doc, { item: pool, price: 1_000_000_000 });
        await line(c, doc, {
          kind: 'advance_deduction',
          price: -1,
          advanceDoc: a2.doc,
          net: -100,
          vat: 0,
        });
        await issue(c, doc, other);
      }),
    ).rejects.toMatchObject(rule('ADVANCE_DEDUCTION'));
  });
});

describe('payments (decisions 0048, 0052)', () => {
  it('a payment is fully allocated at commit, never above a document, never to another customer', async () => {
    const cust = await customer('Payer', { creditLimit: 10_000_000 });
    const other = await customer('Other', { creditLimit: 10_000_000 });
    const svc = await item('S-PAY', 'service', 1_000_000, false);
    const inv = await tx(async (c) => {
      const doc = await draft(c, 'invoice', cust);
      await line(c, doc, { item: svc, price: 1_000_000 });
      await issue(c, doc, cust);
      return doc;
    });
    await expect(
      tx((c) => receive(c, cust, 5_000, [{ doc: inv, amount: 4_000 }])),
    ).rejects.toMatchObject(rule('PAYMENT_UNALLOCATED'));
    await expect(
      tx((c) => receive(c, cust, 20_000, [{ doc: inv, amount: 20_000 }])),
    ).rejects.toMatchObject(rule('ALLOCATION_EXCEEDS'));
    await expect(
      tx((c) => receive(c, other, 1_000, [{ doc: inv, amount: 1_000 }])),
    ).rejects.toMatchObject(rule('ALLOCATION_TARGET'));
    const paid = await tx((c) => receive(c, cust, 10_500, [{ doc: inv, amount: 10_500 }]));
    expect(paid.doc_number).toMatch(/^RCT-/);
    const state = await one<{ s: string }>(
      api,
      `SELECT settlement_status AS s FROM sales.documents WHERE id = $1`,
      [inv],
    );
    expect(state.s).toBe('settled');

    // A bounced cheque: reversed once; the invoice is open again.
    const reversal = await tx(async (c) => {
      const p = await one<{ id: string; doc_number: string }>(
        c,
        `INSERT INTO sales.payments (payment_kind, reversal_of_id, customer_id, payment_method_id, amount_fils,
                                     payment_date, channel, device_id, reason_code_id)
         VALUES ('reversal', $1, $2, $3, 10500, $4, 'office', $5, $6) RETURNING id, doc_number`,
        [paid.id, cust, r.cash, today, device, r.bounced],
      );
      await c.query(
        `INSERT INTO sales.payment_allocations (payment_id, document_id, amount_fils) VALUES ($1, $2, 10500)`,
        [p.id, inv],
      );
      await journal(c, 'payment', p.id, cust);
      return p;
    });
    expect(reversal.doc_number).toMatch(/^RVS-/);
    expect(
      (
        await one<{ s: string }>(
          api,
          `SELECT settlement_status AS s FROM sales.documents WHERE id = $1`,
          [inv],
        )
      ).s,
    ).toBe('open');
    await expect(
      tx((c) =>
        c.query(
          `INSERT INTO sales.payments (payment_kind, reversal_of_id, customer_id, payment_method_id, amount_fils,
                                       payment_date, channel, device_id, reason_code_id)
           VALUES ('reversal', $1, $2, $3, 10500, $4, 'office', $5, $6)`,
          [paid.id, cust, r.cash, today, device, r.bounced],
        ),
      ),
    ).rejects.toBeTruthy();
  });
});

describe('credit notes', () => {
  it('never credit more than the original; a credit note on a payment invoice reverses the advance', async () => {
    const cust = await customer('Returner', { creditLimit: 100_000_000 });
    const svc = await item('S-CN', 'service', 1_000_000, false);
    const inv = await tx(async (c) => {
      const doc = await draft(c, 'invoice', cust);
      const l = await line(c, doc, { item: svc, qty: '2', price: 1_000_000 });
      await issue(c, doc, cust);
      return { doc, line: l.id };
    });
    const credit = (qty: string) =>
      tx(async (c) => {
        const doc = await draft(c, 'credit_note', cust, { original: inv.doc, reason: r.cnReturn });
        await line(c, doc, { item: svc, qty, price: 1_000_000, originalLine: inv.line });
        return issue(c, doc, cust);
      });
    expect((await credit('1')).doc_number).toMatch(/^CN-/);
    await expect(credit('2')).rejects.toMatchObject(rule('NOTE_EXCEEDS')); // 1 + 2 > 2
    await credit('1');

    // Work cancelled: the payment invoice's advance is used up by the credit note.
    const adv = await tx(async (c) => {
      const doc = await draft(c, 'advance_invoice', cust);
      await line(c, doc, { kind: 'advance', price: 10_500_0000 });
      await issue(c, doc, cust);
      await receive(c, cust, 1_050_000, [{ doc, amount: 1_050_000 }]);
      return doc;
    });
    await tx(async (c) => {
      const doc = await draft(c, 'credit_note', cust, { original: adv, reason: r.cnCancel });
      await line(c, doc, { kind: 'item', item: svc, qty: '1', price: 100_000_000 });
      await issue(c, doc, cust);
    });
    const used = await one<{ n: string; v: string }>(
      api,
      `SELECT advance_used_net_fils::text AS n, advance_used_vat_fils::text AS v FROM sales.documents WHERE id = $1`,
      [adv],
    );
    expect(used).toEqual({ n: '1000000', v: '50000' });
  });
});

describe('opening balances (decision 0051) and quotations (0049)', () => {
  it('only the owner enters an opening balance, once per customer', async () => {
    const cust = await customer('Old customer', { creditLimit: 10_000_000 });
    const add = (userId: bigint) =>
      tx(async (c) => {
        const o = await one<{ id: string }>(
          c,
          `INSERT INTO sales.opening_balances (customer_id, balance_date, direction, amount_fils)
           VALUES ($1, $2, 'receivable', 50000) RETURNING id`,
          [cust, today],
        );
        await journal(c, 'opening_balance', o.id, cust);
        return o.id;
      }, userId);
    await expect(add(accountant)).rejects.toMatchObject(denied('OPENING_OWNER_ONLY'));
    const opening = await add(owner);
    await expect(add(owner)).rejects.toMatchObject({ code: '23505' });
    // The oldest debt is paid like any other.
    await tx((c) => receive(c, cust, 50_000, [{ opening, amount: 50_000 }]));
  });

  it('a quotation is numbered at first save; a revision keeps the number and supersedes the sent one', async () => {
    const cust = await customer('Prospect');
    const svc = await item('S-Q', 'service', 1_000_000, false);
    const q = await tx(async (c) => {
      const row = await one<{ id: string; doc_number: string }>(
        c,
        `INSERT INTO sales.quotations (branch_id, business_line_id, customer_id, bill_to_name, quotation_date, valid_until,
                                       price_level_id)
         VALUES ($1, $2, $3, 'Prospect', $4, $4::date + 15, $5) RETURNING id, doc_number`,
        [r.branch, r.line, cust, today, r.level],
      );
      await c.query(
        `INSERT INTO sales.quotation_lines (quotation_id, line_no, item_id, description_ar, description_en, unit_id,
                                            business_line_id, quantity, unit_price_4dp)
         VALUES ($1, 1, $2, 'بند', 'Line', (SELECT unit_id FROM md.items WHERE id = $2), $3, 3, 1000000)`,
        [row.id, svc, r.line],
      );
      await c.query(`UPDATE sales.quotations SET status = 'sent' WHERE id = $1`, [row.id]);
      return row;
    });
    expect(q.doc_number).toMatch(/^Q-/);
    const sent = await one<{ total_fils: string }>(
      api,
      `SELECT total_fils::text FROM sales.quotations WHERE id = $1`,
      [q.id],
    );
    expect(sent.total_fils).toBe('31500');
    const rev = await tx((c) =>
      one<{ doc_number: string; revision: number }>(
        c,
        `INSERT INTO sales.quotations (branch_id, business_line_id, customer_id, bill_to_name, quotation_date, valid_until,
                                       price_level_id, revised_from_id)
         VALUES ($1, $2, $3, 'Prospect', $4, $4::date + 15, $5, $6) RETURNING doc_number, revision`,
        [r.branch, r.line, cust, today, r.level, q.id],
      ),
    );
    expect(rev).toEqual({ doc_number: q.doc_number, revision: 2 });
    expect(
      (
        await one<{ s: string }>(api, `SELECT status AS s FROM sales.quotations WHERE id = $1`, [
          q.id,
        ])
      ).s,
    ).toBe('superseded');
  });
});

describe('the e-invoice outbox (0019) and print template versions (0020, 0050)', () => {
  it('every issued document is queued, not required before the go-live date, and keeps its template version', async () => {
    const cust = await customer('Outbox', { creditLimit: 10_000_000 });
    const svc = await item('S-OUT', 'service', 1_000_000, false);
    const issueOne = () =>
      tx(async (c) => {
        const doc = await draft(c, 'invoice', cust);
        await line(c, doc, { item: svc, price: 1_000_000 });
        await issue(c, doc, cust);
        return doc;
      });
    const before = await issueOne();
    const row = (doc: string) =>
      one<{ status: string; v: string | null }>(
        api,
        `SELECT o.status, d.print_template_version_id::text AS v
           FROM ops.outbox o JOIN sales.documents d ON d.id = o.sales_document_id
          WHERE o.sales_document_id = $1 AND o.channel = 'einvoice'`,
        [doc],
      );
    expect(await row(before)).toMatchObject({ status: 'not_required' });
    expect((await row(before)).v).not.toBeNull();
    await tx((c) =>
      c.query(
        `UPDATE sys.settings SET value = to_jsonb($1::text) WHERE key = 'einvoice.mandatory_from'`,
        [today],
      ),
    );
    expect((await row(await issueOne())).status).toBe('pending');
    await tx((c) =>
      c.query(`UPDATE sys.settings SET value = 'null' WHERE key = 'einvoice.mandatory_from'`),
    );
  });

  it('only the owner saves a new template version; versions never change', async () => {
    const template = (
      await one<{ id: string }>(
        api,
        `SELECT id::text FROM sys.print_templates WHERE doc_kind = 'tax_invoice_a4'`,
      )
    ).id;
    const save = (userId: bigint) =>
      tx(
        (c) =>
          one<{ id: string; version_no: number }>(
            c,
            `INSERT INTO sys.print_template_versions (template_id, settings) VALUES ($1, '{"language":"ar"}')
             RETURNING id::text, version_no`,
            [template],
          ),
        userId,
      );
    await expect(save(accountant)).rejects.toMatchObject(denied('PRINT_OWNER_ONLY'));
    const v2 = await save(owner);
    expect(v2.version_no).toBe(2);
    await expect(
      tx((c) =>
        c.query(`UPDATE sys.print_template_versions SET note = 'x' WHERE id = $1`, [v2.id]),
      ),
    ).rejects.toMatchObject({ code: '42501' }); // the API may not even try; the guard is behind it
  });
});
