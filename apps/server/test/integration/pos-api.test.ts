/**
 * M5 T2–T3 through the API: POS sales on the cashier's own shift only (0004), idempotent (a retry
 * never sells twice), split cash + card with change and the card slip's approval code only (0061),
 * selling beyond stock with a supervisor's approval and a pending oversell adjustment (0003),
 * the cashier's 5% discount limit (0059), a full tax invoice for a VAT-registered customer (0062),
 * cart removals in the audit log (0005), returns refunded from the shift open now (0060), held
 * carts, and the shift: float, paid-in / paid-out, drop, No Sale, the blind count, one recount
 * with approval, the close (Z) and the variance accepted by the accountant (0006, 0056–0058).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CashMovementItem,
  CountResult,
  CustomerDetail,
  DocumentDetail,
  HeldCart,
  ItemDetail,
  ItemStockResponse,
  PosReturnResponse,
  PosSaleResponse,
  PosState,
  ShiftReport,
  ShiftsResponse,
  ShiftSummary,
} from '@artepool/shared/contracts';
import { withBusinessTx } from '../../src/platform/db/tx';
import {
  addDevice,
  addOwner,
  addUser,
  call,
  openSession,
  startTestServer,
  type TestDevice,
  type TestServer,
} from '../support/server';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
type Actor = ((
  method: Method,
  url: string,
  body?: unknown,
  key?: string,
) => ReturnType<typeof call>) & {
  id: bigint;
  pc: TestDevice;
};

let server: TestServer;
let owner: Actor;
let accountant: Actor;
let phone = 2_000_000;
let pcNo = 0;
const ids: Record<string, string> = {};

async function signedIn(username: string, roles: string[], kind: 'pos' | 'office' = 'pos') {
  pcNo += 1;
  const pc = await addDevice(server, { code: `PC-${pcNo}`, kind });
  const id = await addUser(server, { username, roles, pin: '4829' });
  const token = (await openSession(server, { userId: id, deviceId: pc.id })).token;
  return asActor(pc, id, token);
}

function asActor(pc: TestDevice, id: bigint, token: string): Actor {
  const fn = (method: Method, url: string, body?: unknown, key?: string) =>
    call(server, method, url, {
      device: pc,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: key ?? randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
  return Object.assign(fn, { id, pc });
}

/** Another user signing in on the same PC (one PC, many cashiers). */
async function onSamePc(actor: Actor, username: string, roles: string[]) {
  const id = await addUser(server, { username, roles, pin: '4829' });
  const token = (await openSession(server, { userId: id, deviceId: actor.pc.id })).token;
  return asActor(actor.pc, id, token);
}

async function refusal(response: ReturnType<typeof call>) {
  const r = await response;
  const body = r.json<{ error: { code: string; details: Record<string, unknown> } }>();
  return { status: r.statusCode, code: body.error?.code, ...body.error?.details };
}

async function ok<T>(response: ReturnType<typeof call>, status = 200): Promise<T> {
  const r = await response;
  if (r.statusCode !== status) throw new Error(`${r.statusCode}: ${r.body}`);
  return r.json<T>();
}

/** A supervisor's approval (the accountant), asked for by the given user on their PC. */
async function approval(requester: Actor, permission: string, context: object = {}) {
  return withBusinessTx(
    server.db,
    { userId: requester.id, deviceId: requester.pc.id, requestId: randomUUID() },
    async (trx) =>
      (
        await sql<{
          id: string;
        }>`INSERT INTO auth.approvals (permission_code, approved_by, reason_text, context)
                                  VALUES (${permission}, ${accountant.id}, 'Approved at the counter',
                                          ${JSON.stringify(context)}::jsonb)
                                  RETURNING id::text`.execute(trx)
      ).rows[0]!.id,
  );
}

async function item(code: string, price4dp: string, stockMilli?: string) {
  const i = await ok<ItemDetail>(
    owner('POST', '/api/v1/items', {
      code,
      itemType: 'stock',
      nameAr: `صنف ${code}`,
      nameEn: `Item ${code}`,
      categoryId: ids.category,
      unitId: ids.pcs,
      vatCategoryId: ids.vat,
      price: { price4dp, includesVat: true },
      purchaseCost4dp: '50000',
    }),
    201,
  );
  if (stockMilli) {
    await ok(
      owner('POST', '/api/v1/stock/adjustments', {
        kind: 'opening',
        reasonCodeId: ids.opening,
        lines: [{ itemId: i.id, quantityMilli: stockMilli, unitCost4dp: '50000' }],
      }),
      201,
    );
  }
  return i.id;
}

async function stockOf(itemId: string): Promise<string> {
  const s = await ok<ItemStockResponse>(owner('GET', `/api/v1/items/${itemId}/stock`));
  return s.balances.find((b) => b.stockStatus === 'available')?.quantityMilli ?? '0';
}

const open = (who: Actor, float = '50000') =>
  ok<ShiftSummary>(who('POST', '/api/v1/shifts', { openingFloatFils: float }), 201);

const cashPart = (amountFils: string, tenderedFils?: string) => ({
  paymentMethodId: ids.cash!,
  amountFils,
  ...(tenderedFils ? { tenderedFils } : {}),
});

const sale = (who: Actor, body: Record<string, unknown>, key?: string) =>
  who('POST', '/api/v1/pos/sales', { cartId: randomUUID(), ...body }, key);

/** The balance (debit − credit) of an account, in fils. */
async function balance(code: string): Promise<bigint> {
  const { rows } = await sql<{ b: string }>`
    SELECT coalesce(sum(l.debit_fils - l.credit_fils), 0)::text AS b
      FROM gl.journal_lines l JOIN gl.accounts a ON a.id = l.account_id WHERE a.code = ${code}`.execute(
    server.db,
  );
  return BigInt(rows[0]!.b);
}

/** Counts a drawer with 100-dirham notes and an other amount. */
const countBody = (notes100: number, otherFils = '0') => ({
  lines: [{ denominationId: ids.note100!, quantity: notes100 }],
  otherAmountFils: otherFils,
});

beforeAll(async () => {
  server = await startTestServer();
  const office = await addDevice(server, { code: 'OFFICE-POS' });
  const ownerId = await addOwner(server);
  owner = asActor(
    office,
    ownerId,
    (await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' }))
      .token,
  );
  accountant = await signedIn('acc.pos', ['accountant'], 'office');
  const { rows } = await sql<{ kind: string; id: string }>`
    SELECT 'category' AS kind, id::text FROM md.item_categories WHERE code = 'PARTS'
    UNION ALL SELECT 'pcs', id::text FROM md.units WHERE code = 'PCS'
    UNION ALL SELECT 'vat', id::text FROM md.vat_categories WHERE code = 'SR'
    UNION ALL SELECT 'opening', id::text FROM sys.reason_codes WHERE category = 'other' AND code = 'OPENING'
    UNION ALL SELECT 'cnReturn', id::text FROM sys.reason_codes WHERE category = 'credit_note' AND code = 'RETURN'
    UNION ALL SELECT 'petty', id::text FROM sys.reason_codes WHERE category = 'paid_out' AND code = 'PETTY'
    UNION ALL SELECT 'changeFloat', id::text FROM sys.reason_codes WHERE category = 'paid_in' AND code = 'CHANGE_FLOAT'
    UNION ALL SELECT 'giveChange', id::text FROM sys.reason_codes WHERE category = 'no_sale' AND code = 'GIVE_CHANGE'
    UNION ALL SELECT 'cash', id::text FROM md.payment_methods WHERE code = 'CASH'
    UNION ALL SELECT 'card', id::text FROM md.payment_methods WHERE code = 'CARD'
    UNION ALL SELECT 'note100', id::text FROM md.cash_denominations WHERE value_fils = 10000
  `.execute(server.db);
  for (const r of rows) ids[r.kind] ??= r.id;
  await ok(
    owner('PUT', '/api/v1/company', {
      legalNameAr: 'آرتي بول لحمامات السباحة',
      legalNameEn: 'ARTEPOOL Swimming Pools',
      vatRegistered: true,
      trn: '100123456789012',
      addressAr: 'العين، أبوظبي',
      addressEn: 'Al Ain, Abu Dhabi',
    }),
  );
});
afterAll(() => server.close());

describe('the POS PC and its shift (decisions 0004, 0021)', () => {
  it('a PC enrolled again under the same name gets a drawer of its own', async () => {
    // The old enrollment made drawer REG-TWIN-PC, then was revoked.
    const first = await addDevice(server, { code: 'TWIN-PC', kind: 'pos' });
    const oldCashier = await addUser(server, {
      username: 'cash.twin0',
      roles: ['cashier'],
      pin: '4829',
    });
    await open(
      asActor(
        first,
        oldCashier,
        (await openSession(server, { userId: oldCashier, deviceId: first.id })).token,
      ),
      '0',
    );
    await withBusinessTx(
      server.db,
      { userId: owner.id, deviceId: owner.pc.id, requestId: randomUUID() },
      (trx) =>
        trx
          .updateTable('auth.devices')
          .set({ status: 'revoked', revoke_reason: 'Enrolled again' })
          .where('id', '=', first.id)
          .execute(),
    );
    // The same PC enrolled again: opening a shift there works, on a drawer of its own.
    const again = await addDevice(server, { code: 'TWIN-PC', kind: 'pos' });
    const id = await addUser(server, { username: 'cash.twin', roles: ['cashier'], pin: '4829' });
    await open(
      asActor(again, id, (await openSession(server, { userId: id, deviceId: again.id })).token),
      '0',
    );
    const codes = await server.db
      .selectFrom('cash.registers')
      .select('code')
      .where('device_id', 'in', [first.id, again.id])
      .orderBy('id')
      .execute();
    expect(codes.map((r) => r.code)).toEqual(['REG-TWIN-PC', 'REG-TWIN-PC-2']);
  });

  it('shifts open only on a POS PC; one open shift per drawer; only its cashier sells on it', async () => {
    const office = await signedIn('cash.office', ['cashier'], 'office');
    expect(
      await refusal(office('POST', '/api/v1/shifts', { openingFloatFils: '0' })),
    ).toMatchObject({ rule: 'POS_DEVICE_ONLY' });
    const a = await signedIn('cash.a', ['cashier']);
    const shift = await open(a);
    expect(shift.shiftNumber).toMatch(/^Z-/);
    const b = await onSamePc(a, 'cash.b', ['cashier']);
    expect(await refusal(b('POST', '/api/v1/shifts', { openingFloatFils: '0' }))).toMatchObject({
      rule: 'SHIFT_ALREADY_OPEN',
    });
    // The same cashier on another POS PC: refused, naming the PC the shift is open on.
    const aPc = await server.db
      .selectFrom('auth.devices')
      .select('code')
      .where('id', '=', a.pc.id)
      .executeTakeFirstOrThrow();
    pcNo += 1;
    const other = await addDevice(server, { code: `PC-${pcNo}`, kind: 'pos' });
    const aThere = asActor(
      other,
      a.id,
      (await openSession(server, { userId: a.id, deviceId: other.id })).token,
    );
    expect(
      await refusal(aThere('POST', '/api/v1/shifts', { openingFloatFils: '0' })),
    ).toMatchObject({ rule: 'SHIFT_OPEN_ELSEWHERE', deviceCode: aPc.code });
    const state = await ok<PosState>(b('GET', '/api/v1/pos/state'));
    expect(state.shift).toBeNull();
    expect(state.drawerBusyWith).not.toBeNull();
    const svc = await item('POS-OWN', '105000', '5000');
    expect(
      await refusal(
        sale(b, { lines: [{ itemId: svc, quantityMilli: '1000' }], payments: [cashPart('1050')] }),
      ),
    ).toMatchObject({ code: 'PERMISSION_DENIED', rule: 'SHIFT_NOT_OWNER' });
    const mine = await ok<PosState>(a('GET', '/api/v1/pos/state'));
    expect(mine.shift?.id).toBe(shift.id);
    expect(mine.paymentMethods.map((m) => m.code)).toEqual(['CASH', 'CARD']);
    expect(mine.denominations.map((d) => d.valueFils)).toContain('5');
    // The float came from the safe (row 18).
    expect(await balance('1120')).toBe(-50_000n + 0n);
  });
});

describe('POS sales', () => {
  let cashier: Actor;
  let shiftId: string;
  beforeAll(async () => {
    cashier = await signedIn('cash.sales', ['cashier']);
    shiftId = (await open(cashier)).id;
  });

  it('a cash sale: POS- number, change, stock, journal, drawer event; a retry never sells twice', async () => {
    const a = await item('POS-A', '105000', '10000'); // 10.50 incl. VAT
    const b = await item('POS-B', '21000', '10000'); // 2.10 incl. VAT
    const key = randomUUID();
    const body = {
      cartId: randomUUID(),
      lines: [
        { itemId: a, quantityMilli: '2000' },
        { itemId: b, quantityMilli: '1000' },
      ],
      payments: [cashPart('2310', '5000')],
    };
    const first = await ok<PosSaleResponse>(cashier('POST', '/api/v1/pos/sales', body, key), 201);
    expect(first.document.docNumber).toMatch(/^POS-/);
    expect(first.document.totalFils).toBe('2310');
    expect(first.document.vatFils).toBe('110');
    expect(first.document.invoiceFormat).toBe('simplified');
    expect(first.changeFils).toBe('2690');
    expect(first.opensDrawer).toBe(true);
    expect(first.payments[0]).toMatchObject({ tenderedFils: '5000', changeFils: '2690' });
    // The receipt: the seller frozen at issue, the cashier, the shift, the change.
    expect(first.receipt).toMatchObject({
      seller: { nameEn: 'ARTEPOOL Swimming Pools', trn: '100123456789012' },
      changeFils: '2690',
      printCount: 0,
      markCopies: true,
    });
    expect(first.receipt.shiftNumber).toMatch(/^Z-/);
    expect(
      await ok<{ printCount: number }>(
        cashier('POST', `/api/v1/pos/receipts/${first.document.id}/printed`),
      ),
    ).toEqual({ printCount: 1 });
    // A second print is a reprint: the cashier holds documents.reprint, so it is counted.
    expect(
      await ok<{ printCount: number }>(
        cashier('POST', `/api/v1/pos/receipts/${first.document.id}/printed`),
      ),
    ).toEqual({ printCount: 2 });
    const again = await ok<PosSaleResponse>(cashier('POST', '/api/v1/pos/sales', body, key), 201);
    expect(again.document.docNumber).toBe(first.document.docNumber);
    expect(await stockOf(a)).toBe('8000');
    const { rows } = await sql<{ n: string; events: string }>`
      SELECT (SELECT count(*) FROM sales.documents WHERE pos_cart_id = ${body.cartId})::text AS n,
             (SELECT count(*) FROM cash.drawer_events WHERE sales_document_id = ${first.document.id})::text AS events`.execute(
      server.db,
    );
    expect(rows[0]).toEqual({ n: '1', events: '1' });
  });

  it('split cash + card: the card part carries the slip’s approval code only', async () => {
    const a = await item('POS-SPLIT', '1050000', '5000'); // 105.00
    expect(
      await refusal(
        sale(cashier, {
          lines: [{ itemId: a, quantityMilli: '1000' }],
          payments: [cashPart('5000'), { paymentMethodId: ids.card, amountFils: '5500' }],
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      await refusal(
        sale(cashier, {
          lines: [{ itemId: a, quantityMilli: '1000' }],
          payments: [
            { paymentMethodId: ids.card, amountFils: '10500', approvalCode: '4111111111111111' },
          ],
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    const r = await ok<PosSaleResponse>(
      sale(cashier, {
        lines: [{ itemId: a, quantityMilli: '1000' }],
        payments: [
          cashPart('5000', '5000'),
          { paymentMethodId: ids.card, amountFils: '5500', approvalCode: 'A1B2C3' },
        ],
      }),
      201,
    );
    expect(r.payments.map((p) => [p.methodKind, p.amountFils, p.reference])).toEqual([
      ['cash', '5000', null],
      ['card', '5500', 'A1B2C3'],
    ]);
    expect(r.document.settlementStatus).toBe('settled');
  });

  it('paying more than is due is refused; a cash customer cannot leave it unpaid', async () => {
    const a = await item('POS-PAY', '105000', '5000');
    expect(
      await refusal(
        sale(cashier, {
          lines: [{ itemId: a, quantityMilli: '1000' }],
          payments: [cashPart('1051')],
        }),
      ),
    ).toMatchObject({ rule: 'PAYMENT_MISMATCH' });
    expect(
      await refusal(
        sale(cashier, {
          lines: [{ itemId: a, quantityMilli: '1000' }],
          payments: [cashPart('1000')],
        }),
      ),
    ).toMatchObject({ rule: 'CREDIT_LIMIT' });
  });

  it('selling beyond stock needs a supervisor; the oversell adjustment waits for review (0003)', async () => {
    const a = await item('POS-OVER', '105000', '1000');
    const refused = await refusal(
      sale(cashier, {
        lines: [{ itemId: a, quantityMilli: '3000' }],
        payments: [cashPart('3150')],
      }),
    );
    expect(refused).toMatchObject({ code: 'PERMISSION_DENIED', rule: 'OVERSELL_APPROVAL' });
    expect((refused as Record<string, unknown>).shortages).toEqual([
      expect.objectContaining({ code: 'POS-OVER', neededMilli: '3000', availableMilli: '1000' }),
    ]);
    const r = await ok<PosSaleResponse>(
      sale(cashier, {
        lines: [{ itemId: a, quantityMilli: '3000' }],
        payments: [cashPart('3150')],
        oversellApprovalId: await approval(cashier, 'pos.oversell'),
      }),
      201,
    );
    expect(r.oversellAdjustmentNumber).toMatch(/^ADJ-/);
    expect(await stockOf(a)).toBe('0');
    const { rows } = await sql<{ review_status: string }>`
      SELECT review_status FROM inv.adjustments WHERE doc_number = ${r.oversellAdjustmentNumber}`.execute(
      server.db,
    );
    expect(rows[0]?.review_status).toBe('pending');
  });

  it('a cashier discounts up to 5%; above it a supervisor approves (0059)', async () => {
    const a = await item('POS-DISC', '1050000', '5000'); // 105.00
    const line = (bp: number) => [{ itemId: a, quantityMilli: '1000', lineDiscountBp: bp }];
    expect(
      await refusal(sale(cashier, { lines: line(1000), payments: [cashPart('9450')] })),
    ).toMatchObject({ rule: 'DISCOUNT_OVER_LIMIT' });
    await ok(sale(cashier, { lines: line(500), payments: [cashPart('9975')] }), 201);
    await ok(
      sale(cashier, {
        lines: line(1000),
        payments: [cashPart('9450')],
        approvalId: await approval(cashier, 'sales.discount_over_limit'),
      }),
      201,
    );
    // A changed price always needs a supervisor.
    expect(
      await refusal(
        sale(cashier, {
          lines: [{ itemId: a, quantityMilli: '1000', unitPrice4dp: '1000000' }],
          payments: [cashPart('10000')],
        }),
      ),
    ).toMatchObject({ rule: 'PRICE_OVERRIDE' });
  });

  it('a VAT-registered customer gets a full tax invoice with their TRN (0010, 0062)', async () => {
    phone += 1;
    const c = await ok<CustomerDetail>(
      owner('POST', '/api/v1/customers', {
        customerType: 'company',
        name: 'Pool Contractor LLC',
        phone: `050 ${phone}`,
        isVatRegistered: true,
        trn: '100987654321003',
        addressLine: 'Sanaiya, Al Ain',
      }),
      201,
    );
    const a = await item('POS-TRN', '105000', '5000');
    const r = await ok<PosSaleResponse>(
      sale(cashier, {
        customerId: c.id,
        lines: [{ itemId: a, quantityMilli: '1000' }],
        payments: [cashPart('1050')],
      }),
      201,
    );
    expect(r.document.invoiceFormat).toBe('full');
    expect(r.document.billToTrn).toBe('100987654321003');
  });

  it('lines removed from the cart are written to the audit log with the invoice (0005)', async () => {
    const a = await item('POS-REM', '105000', '5000');
    const r = await ok<PosSaleResponse>(
      sale(cashier, {
        lines: [{ itemId: a, quantityMilli: '1000' }],
        payments: [cashPart('1050')],
        removals: [{ itemId: a, quantityMilli: '2000', removedAt: new Date().toISOString() }],
      }),
      201,
    );
    const { rows } = await sql<{ action: string }>`
      SELECT action FROM audit.log WHERE entity_type = 'sales.documents' AND entity_id = ${r.document.id}
        AND action = 'event:pos.cart_removed_lines'`.execute(server.db);
    expect(rows).toHaveLength(1);
  });

  it('a cart is held and resumed on the same PC', async () => {
    const cartId = randomUUID();
    const held = await ok<HeldCart>(
      cashier('POST', '/api/v1/pos/held-carts', { cartId, label: 'Mr. Ali', cart: { lines: [] } }),
      201,
    );
    const list = await ok<HeldCart[]>(cashier('GET', '/api/v1/pos/held-carts'));
    expect(list.map((h) => h.cartId)).toContain(cartId);
    await ok(cashier('POST', `/api/v1/pos/held-carts/${held.id}/resume`));
    expect(
      (await ok<HeldCart[]>(cashier('GET', '/api/v1/pos/held-carts'))).map((h) => h.cartId),
    ).not.toContain(cartId);
    expect(shiftId).toBeTruthy();
  });
});

describe('returns at the POS (decision 0060)', () => {
  it('needs a supervisor; a credit note on the original; refunded from the shift open now; card back to card', async () => {
    const cashier = await signedIn('cash.ret', ['cashier']);
    await open(cashier, '0');
    const a = await item('POS-RET', '1050000', '5000'); // 105.00
    const cashSale = await ok<PosSaleResponse>(
      sale(cashier, {
        lines: [{ itemId: a, quantityMilli: '2000' }],
        payments: [cashPart('21000')],
      }),
      201,
    );
    const cardSale = await ok<PosSaleResponse>(
      sale(cashier, {
        lines: [{ itemId: a, quantityMilli: '1000' }],
        payments: [{ paymentMethodId: ids.card, amountFils: '10500', approvalCode: 'ZX99' }],
      }),
      201,
    );
    // Close the first shift and open a new one: the return is refunded from the new drawer.
    await ok<CountResult>(cashier('POST', '/api/v1/shifts/current/count', countBody(2, '1000')));
    await ok<ShiftReport>(cashier('POST', '/api/v1/shifts/current/close', {}));
    const second = await open(cashier, '50000');

    const ret = (original: PosSaleResponse, approvalId?: string) =>
      cashier('POST', '/api/v1/pos/returns', {
        originalDocumentId: original.document.id,
        reasonCodeId: ids.cnReturn,
        reasonText: 'Customer returned it',
        lines: [
          {
            originalLineId: original.document.lines[0]!.id,
            quantityMilli: '1000',
            returnStockStatus: 'available',
          },
        ],
        ...(approvalId ? { approvalId } : {}),
      });
    expect(await refusal(ret(cashSale))).toMatchObject({ code: 'VALIDATION_FAILED' });
    const back = await ok<PosReturnResponse>(
      ret(cashSale, await approval(cashier, 'credit_notes.issue')),
      201,
    );
    expect(back.creditNote.docNumber).toMatch(/^CN-/);
    expect(back.refunds).toEqual([
      expect.objectContaining({ methodKind: 'cash', amountFils: '10500' }),
    ]);
    expect(back.opensDrawer).toBe(true);
    expect(await stockOf(a)).toBe('3000');
    const report = await ok<ShiftReport>(cashier('GET', `/api/v1/shifts/${second.id}`));
    expect(report.returnsCount).toBe(1);
    expect(report.byMethod.find((m) => m.kind === 'cash')?.refundedFils).toBe('10500');

    const cardBack = await ok<PosReturnResponse>(
      ret(cardSale, await approval(cashier, 'credit_notes.issue')),
      201,
    );
    expect(cardBack.refunds).toEqual([
      expect.objectContaining({ methodKind: 'card', amountFils: '10500' }),
    ]);
    expect(cardBack.opensDrawer).toBe(false);
  });
});

describe('the shift (decisions 0004, 0006, 0056–0058)', () => {
  it('float, paid-in/out, drop, No Sale, blind count, one recount, close, accept', async () => {
    const cashier = await signedIn('cash.shift', ['cashier']);
    const shift = await open(cashier, '50000'); // 500.00
    const a = await item('POS-SHIFT', '1050000', '10000'); // 105.00
    await ok(
      sale(cashier, {
        lines: [{ itemId: a, quantityMilli: '2000' }],
        payments: [cashPart('21000', '25000')],
      }),
      201,
    );

    // Paid-out needs approval; paid-in and drop do not.
    const paidOut = {
      movementType: 'paid_out',
      amountFils: '2000',
      reasonCodeId: ids.petty,
      note: 'Water bottles',
    };
    expect(
      await refusal(cashier('POST', '/api/v1/shifts/current/movements', paidOut)),
    ).toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await ok(
      cashier('POST', '/api/v1/shifts/current/movements', {
        ...paidOut,
        approvalId: await approval(cashier, 'cash.paid_out', { amountFils: '2000' }),
      }),
      201,
    );
    await ok(
      cashier('POST', '/api/v1/shifts/current/movements', {
        movementType: 'paid_in',
        amountFils: '1000',
        reasonCodeId: ids.changeFloat,
      }),
      201,
    );
    const drop = await ok<{ movement: CashMovementItem; dropDue: boolean }>(
      cashier('POST', '/api/v1/shifts/current/movements', {
        movementType: 'cash_drop',
        amountFils: '30000',
      }),
      201,
    );
    expect(drop.movement.voucherNumber).toMatch(/^CV-/);
    // No Sale: the cashier does not hold pos.no_sale by default.
    expect(
      await refusal(
        cashier('POST', '/api/v1/shifts/current/no-sale', { reasonCodeId: ids.giveChange }),
      ),
    ).toMatchObject({ code: 'PERMISSION_DENIED' });

    // X report: no expected cash for the cashier before the count (blind count).
    const x = await ok<ShiftReport>(cashier('GET', '/api/v1/shifts/current/x-report'));
    expect(x.salesCount).toBe(1);
    expect(x.grossSalesFils).toBe('21000');
    expect(x.expectedCashFils).toBeNull();

    // Expected: 500 + 210 − 20 + 10 − 300 = 400.00. Counted 3 × 100 + 99.95 = 399.95.
    const counted = await ok<CountResult>(
      cashier('POST', '/api/v1/shifts/current/count', countBody(3, '9995')),
    );
    expect(counted).toMatchObject({
      countedFils: '39995',
      expectedFils: '40000',
      varianceFils: '-5',
      canRecount: true,
    });
    expect(
      await refusal(cashier('POST', '/api/v1/shifts/current/count', countBody(4))),
    ).toMatchObject({
      rule: 'COUNT_ALREADY_DONE',
    });
    expect(
      await refusal(
        cashier('POST', '/api/v1/shifts/current/recount', {
          ...countBody(4),
          approvalId: await approval(cashier, 'cash.paid_out'),
        }),
      ),
    ).toMatchObject({ code: 'APPROVAL_INVALID' });
    const recount = await ok<CountResult>(
      cashier('POST', '/api/v1/shifts/current/recount', {
        ...countBody(3, '9000'),
        approvalId: await approval(cashier, 'shifts.recount'),
      }),
    );
    expect(recount).toMatchObject({
      isRecount: true,
      countedFils: '39000',
      varianceFils: '-1000',
      canRecount: false,
    });
    expect(
      await refusal(
        cashier('POST', '/api/v1/shifts/current/recount', {
          ...countBody(4),
          approvalId: await approval(cashier, 'shifts.recount'),
        }),
      ),
    ).toMatchObject({ rule: 'RECOUNT_USED' });

    const z = await ok<ShiftReport>(
      cashier('POST', '/api/v1/shifts/current/close', { varianceNote: 'Short 10' }),
    );
    expect(z.shift.status).toBe('closed');
    expect(z.counts.map((c) => [c.isRecount, c.totalFils])).toEqual([
      [false, '39995'],
      [true, '39000'],
    ]);
    expect(z).toMatchObject({
      expectedCashFils: '40000',
      countedCashFils: '39000',
      varianceFils: '-1000',
    });
    expect(z.movements.map((m) => m.movementType)).toEqual([
      'opening_float',
      'paid_out',
      'paid_in',
      'cash_drop',
      'closing_transfer',
    ]);

    // The cashier cannot accept; the accountant does, and the short posts to 6910.
    expect(
      await refusal(cashier('POST', `/api/v1/shifts/${shift.id}/accept-variance`, { note: 'ok' })),
    ).toMatchObject({ code: 'PERMISSION_DENIED' });
    const pending = await ok<ShiftsResponse>(
      accountant('GET', '/api/v1/shifts?pendingAcceptance=true'),
    );
    expect(pending.shifts.map((s) => s.id)).toContain(shift.id);
    const before6910 = await balance('6910');
    const accepted = await ok<ShiftReport>(
      accountant('POST', `/api/v1/shifts/${shift.id}/accept-variance`, {
        note: 'Miscount, accepted',
      }),
    );
    expect(accepted.acceptance?.note).toBe('Miscount, accepted');
    expect((await balance('6910')) - before6910).toBe(1000n);
    // A cashier sees only their own shifts.
    const mine = await ok<ShiftsResponse>(cashier('GET', '/api/v1/shifts'));
    expect(mine.shifts.every((s) => s.cashierId === cashier.id.toString())).toBe(true);
  });

  it('three variances above AED 20 within 30 days raise the repeated-variance alert (0058)', async () => {
    const cashier = await signedIn('cash.repeat', ['cashier']);
    for (let i = 0; i < 3; i += 1) {
      await open(cashier, '10000');
      await ok(cashier('POST', '/api/v1/shifts/current/count', countBody(0, '7000'))); // 30.00 short
      await ok(cashier('POST', '/api/v1/shifts/current/close', {}));
    }
    const alerts = await ok<{ alertType: string; params: Record<string, string> }[]>(
      accountant('GET', '/api/v1/shifts/alerts'),
    );
    expect(
      alerts.some(
        (a) => a.alertType === 'repeated_variance' && a.params.cashierId === cashier.id.toString(),
      ),
    ).toBe(true);
  });

  it('the drop alert shows when the drawer holds more than AED 3,000 (0057)', async () => {
    const cashier = await signedIn('cash.drop', ['cashier']);
    await open(cashier, '290000');
    const a = await item('POS-BIG', '1050000', '10000');
    const r = await ok<PosSaleResponse>(
      sale(cashier, {
        lines: [{ itemId: a, quantityMilli: '1000' }],
        payments: [cashPart('10500')],
      }),
      201,
    );
    expect(r.dropDue).toBe(true);
    expect((await ok<PosState>(cashier('GET', '/api/v1/pos/state'))).dropDue).toBe(true);
  });
});

describe('A4 cash taken on the drawer (decision 0063)', () => {
  it('goes into the cashier’s open shift; office cash still goes to the safe; INV shown for information', async () => {
    // A supervisor who also sells A4 invoices, on a POS PC, with the drawer open.
    const seller = await signedIn('cash.a4', ['accountant']);
    const shift = await open(seller, '10000'); // 100.00
    phone += 1;
    const c = await ok<CustomerDetail>(
      owner('POST', '/api/v1/customers', {
        customerType: 'company',
        name: 'Villa owner',
        isVatRegistered: false,
        phone: `050 ${phone}`,
      }),
      201,
    );
    const pump = await item('A4-PUMP', '1050000', '5000'); // 105.00 incl. VAT
    const draft = await ok<DocumentDetail>(
      seller('POST', '/api/v1/sales/invoices', {
        customerId: c.id,
        lines: [{ itemId: pump, quantityMilli: '1000' }],
      }),
      201,
    );
    const drawer = await balance('1110');
    const safe = await balance('1120');
    const issued = await ok<DocumentDetail>(
      seller('POST', `/api/v1/sales/documents/${draft.id}/issue`, {
        rowVersion: draft.rowVersion,
        payments: [cashPart('10500')],
      }),
    );
    expect(issued.docNumber).toMatch(/^INV-/);

    // The cash is in the drawer: the shift, the expected cash and the drawers account.
    const { rows } = await sql<{ channel: string; shift_id: string | null; expected: string }>`
      SELECT p.channel, p.shift_id::text, cash.expected_cash(${shift.id}::bigint)::text AS expected
        FROM sales.payment_allocations a JOIN sales.payments p ON p.id = a.payment_id
       WHERE a.document_id = ${issued.id}::bigint`.execute(server.db);
    expect(rows).toEqual([{ channel: 'pos', shift_id: shift.id, expected: '20500' }]);
    expect((await balance('1110')) - drawer).toBe(10_500n);
    expect((await balance('1120')) - safe).toBe(0n);

    // The X report: the money under Cash, and the INV invoice on its own line.
    const x = await ok<ShiftReport>(seller('GET', '/api/v1/shifts/current/x-report'));
    expect(x.salesCount).toBe(0);
    expect(x).toMatchObject({
      a4InvoicesCount: 1,
      a4InvoicesFils: '10500',
      totalSalesFils: '10500',
      vatFils: '500',
    });
    expect(x.byMethod.find((m) => m.methodId === ids.cash)?.receivedFils).toBe('10500');

    // Card taken the same way joins the shift's card total, never its expected cash.
    await ok(
      seller('POST', '/api/v1/sales/payments', {
        customerId: c.id,
        part: { paymentMethodId: ids.card, amountFils: '2000', reference: 'APP 445566' },
        asAdvance: true,
      }),
      201,
    );
    const x2 = await ok<ShiftReport>(seller('GET', '/api/v1/shifts/current/x-report'));
    expect(x2.byMethod.find((m) => m.methodId === ids.card)?.receivedFils).toBe('2000');
    expect(x2.expectedCashFils).toBe('20500');

    // The same cash taken in the office (no drawer shift there) goes to the safe (0047).
    const before = await balance('1120');
    await ok(
      accountant('POST', '/api/v1/sales/payments', {
        customerId: c.id,
        part: cashPart('1000'),
        asAdvance: true,
      }),
      201,
    );
    expect((await balance('1120')) - before).toBe(1_000n);
    expect(
      (await ok<ShiftReport>(seller('GET', '/api/v1/shifts/current/x-report'))).expectedCashFils,
    ).toBe('20500');
  });
});
