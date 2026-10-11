/**
 * M3 T4–T8: stock adjustments, counts, the journal and the stock figures, through the API. Each
 * operation is one transaction with its movements and journal entry; values follow
 * stock.view_cost (decision 0040); approvals above the threshold (0041); opening stock by the
 * owner only (0042); blind counts (0044).
 */
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AdjustmentDetail,
  AdjustmentsResponse,
  CountDetail,
  ImportCheckResponse,
  ItemDetail,
  ItemStockResponse,
  ItemsResponse,
  JournalEntryDetail,
  JournalResponse,
  StockSummary,
  TrialBalanceResponse,
} from '@artepool/shared/contracts';
import { withBusinessTx } from '../../src/platform/db/tx';
import { postEntry } from '../../src/modules/ledger/posting';
import { stockPosting } from '../../src/modules/ledger/stock-posting';
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
type Actor = (method: Method, url: string, body?: unknown) => ReturnType<typeof call>;

let server: TestServer;
let owner: Actor;
let accountant: Actor;
let storekeeper: Actor;
let cashier: Actor;
let storekeeperId: bigint;
let storekeeperPc: TestDevice;
let accountantId: bigint;
const ids = {
  category: '',
  unit: '',
  vat: '',
  opening: '',
  damaged: '',
  found: '',
  broken: '',
  scrapped: '',
};
const countReason = { miscount: '', loss: '' };

function actor(device: TestDevice, token: string): Actor {
  return (method, url, body) =>
    call(server, method, url, {
      device,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
}

async function signedIn(username: string, roles: string[]) {
  const pc = await addDevice(server, { code: `PC-${username}` });
  const id = await addUser(server, { username, roles });
  return {
    act: actor(pc, (await openSession(server, { userId: id, deviceId: pc.id })).token),
    id,
    pc,
  };
}

async function refusal(response: ReturnType<typeof call>) {
  const r = await response;
  const body = r.json<{ error: { code: string; details: Record<string, unknown> } }>();
  return { status: r.statusCode, code: body.error?.code, ...body.error?.details };
}

async function item(code: string, cost: string | null = null): Promise<ItemDetail> {
  const r = await owner('POST', '/api/v1/items', {
    code,
    itemType: 'stock',
    nameAr: `صنف ${code}`,
    nameEn: `Item ${code}`,
    categoryId: ids.category,
    unitId: ids.unit,
    vatCategoryId: ids.vat,
    isSellable: false,
    reorderLevelMilli: '5000',
    ...(cost !== null ? { purchaseCost4dp: cost } : {}),
  });
  expect(r.statusCode).toBe(201);
  return r.json<ItemDetail>();
}

const adjust = (who: Actor, body: Record<string, unknown>) =>
  who('POST', '/api/v1/stock/adjustments', body);

async function entryOf(adjustment: AdjustmentDetail): Promise<Record<string, [string, string]>> {
  const entry = (
    await owner('GET', `/api/v1/journal/${adjustment.journalEntryId}`)
  ).json<JournalEntryDetail>();
  return Object.fromEntries(entry.lines.map((l) => [l.accountCode, [l.debitFils, l.creditFils]]));
}

beforeAll(async () => {
  server = await startTestServer();
  const office = await addDevice(server, { code: 'OFFICE-01' });
  const ownerId = await addOwner(server);
  owner = actor(
    office,
    (await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' }))
      .token,
  );
  const acc = await signedIn('acc.inv', ['accountant']);
  accountant = acc.act;
  accountantId = acc.id;
  const store = await signedIn('store.inv', ['storekeeper']);
  storekeeper = store.act;
  storekeeperId = store.id;
  storekeeperPc = store.pc;
  cashier = (await signedIn('cash.inv', ['cashier'])).act;

  const { rows: refs } = await sql<{ kind: string; id: string }>`
    SELECT 'category' AS kind, id::text FROM md.item_categories WHERE code = 'PARTS'
    UNION ALL SELECT 'unit', id::text FROM md.units WHERE code = 'PCS'
    UNION ALL SELECT 'vat', id::text FROM md.vat_categories WHERE code = 'SR'
    UNION ALL SELECT 'opening', id::text FROM sys.reason_codes WHERE category = 'other' AND code = 'OPENING'
    UNION ALL SELECT 'damaged', id::text FROM sys.reason_codes WHERE category = 'stock_decrease' AND code = 'DAMAGED'
    UNION ALL SELECT 'found', id::text FROM sys.reason_codes WHERE category = 'stock_increase' AND code = 'FOUND'
    UNION ALL SELECT 'broken', id::text FROM sys.reason_codes WHERE category = 'defective' AND code = 'BROKEN'
    UNION ALL SELECT 'scrapped', id::text FROM sys.reason_codes WHERE category = 'write_off' AND code = 'SCRAPPED'
    UNION ALL SELECT 'miscount', id::text FROM sys.reason_codes WHERE category = 'stock_count' AND code = 'MISCOUNT'
    UNION ALL SELECT 'loss', id::text FROM sys.reason_codes WHERE category = 'stock_count' AND code = 'LOSS'
  `.execute(server.db);
  for (const r of refs) {
    if (r.kind === 'miscount' || r.kind === 'loss') countReason[r.kind] = r.id;
    else ids[r.kind as keyof typeof ids] = r.id;
  }
});
afterAll(() => server.close());

describe('opening stock (decision 0042)', () => {
  it('the owner posts it: exact values, Inventory / Opening balance equity, an empty cost takes the purchase price', async () => {
    const a = await item('OPN-0001');
    const b = await item('OPN-0002', '250000'); // purchase price 25.00
    const r = await adjust(owner, {
      kind: 'opening',
      reasonCodeId: ids.opening,
      lines: [
        { itemId: a.id, quantityMilli: '10000', unitCost4dp: '12345' }, // 10 × 1.2345 = 12.35
        { itemId: b.id, quantityMilli: '2000' }, // 2 × 25.00 = 50.00
      ],
    });
    expect(r.statusCode).toBe(201);
    const doc = r.json<AdjustmentDetail>();
    expect(doc).toMatchObject({ kind: 'opening', status: 'posted', totalValueFils: '6235' });
    expect(doc.docNumber).toMatch(/^ADJ-/);
    expect(doc.journalEntryNumber).toMatch(/^JV-/);
    expect(await entryOf(doc)).toEqual({ '1310': ['6235', '0'], '3900': ['0', '6235'] });
  });

  it('nobody else may post opening stock; an item with no cost at all is refused', async () => {
    const c = await item('OPN-0003');
    expect(
      await refusal(
        adjust(accountant, {
          kind: 'opening',
          reasonCodeId: ids.opening,
          lines: [{ itemId: c.id, quantityMilli: '1000' }],
        }),
      ),
    ).toMatchObject({ status: 403, code: 'PERMISSION_DENIED', permission: 'stock.opening' });
    expect(
      await refusal(
        adjust(owner, {
          kind: 'opening',
          reasonCodeId: ids.opening,
          lines: [{ itemId: c.id, quantityMilli: '1000' }],
        }),
      ),
    ).toMatchObject({ status: 422, rule: 'COST_UNKNOWN' });
  });

  it('comes from Excel: checked first, then posted as one document (all rows or none)', async () => {
    const x = await item('OPN-XL01');
    const y = await item('OPN-XL02', '15000');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Data');
    sheet.addRow(['Code', 'Quantity', 'Unit cost (excl. VAT)']);
    sheet.addRow(['OPN-XL01', '3', '2.5']);
    sheet.addRow(['OPN-XL02', '4', null]);
    sheet.addRow(['NOPE-0001', '1', '1']);
    const bad = {
      fileName: 'opening.xlsx',
      dataBase64: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64'),
    };
    const rejected = (
      await owner('POST', '/api/v1/imports/opening_stock/check', bad)
    ).json<ImportCheckResponse>();
    expect(rejected).toMatchObject({ status: 'rejected', rowsInvalid: 1 });
    sheet.spliceRows(4, 1);
    const good = {
      fileName: 'opening.xlsx',
      dataBase64: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64'),
    };
    const checked = (
      await owner('POST', '/api/v1/imports/opening_stock/check', good)
    ).json<ImportCheckResponse>();
    expect(checked).toMatchObject({ status: 'validated', rowsValid: 2 });
    expect(
      (await owner('POST', `/api/v1/imports/opening_stock/${checked.batchId}/commit`, good))
        .statusCode,
    ).toBe(200);
    const stockOf = async (id: string) =>
      (await owner('GET', `/api/v1/items/${id}/stock`)).json<ItemStockResponse>().balances[0];
    expect(await stockOf(x.id)).toMatchObject({ quantityMilli: '3000', value4dp: '75000' });
    expect(await stockOf(y.id)).toMatchObject({ quantityMilli: '4000', value4dp: '60000' });
    expect(
      (await storekeeper('POST', '/api/v1/imports/opening_stock/check', good)).statusCode,
    ).toBe(403);
  });
});

describe('adjustments', () => {
  it('the worked example: 10 × 1.2345 → −3 → −7, the books end at exactly 0.00', async () => {
    const it1 = await item('ADJ-T001');
    await adjust(owner, {
      kind: 'opening',
      reasonCodeId: ids.opening,
      lines: [{ itemId: it1.id, quantityMilli: '10000', unitCost4dp: '12345' }],
    });
    const out3 = (
      await adjust(accountant, {
        kind: 'decrease',
        reasonCodeId: ids.damaged,
        lines: [{ itemId: it1.id, quantityMilli: '3000' }],
      })
    ).json<AdjustmentDetail>();
    expect(out3.totalValueFils).toBe('-371');
    expect(await entryOf(out3)).toEqual({ '5600': ['371', '0'], '1310': ['0', '371'] });
    const out7 = (
      await adjust(accountant, {
        kind: 'decrease',
        reasonCodeId: ids.damaged,
        lines: [{ itemId: it1.id, quantityMilli: '7000' }],
      })
    ).json<AdjustmentDetail>();
    expect(out7.totalValueFils).toBe('-864');
    const card = (await owner('GET', `/api/v1/items/${it1.id}/stock`)).json<ItemStockResponse>();
    expect(card.balances[0]).toMatchObject({
      quantityMilli: '0',
      value4dp: '0',
      bookValueFils: '0',
      avgUnitCost4dp: '12345',
    });
    expect(card.movements.map((m) => m.movementType)).toEqual([
      'adjustment_out',
      'adjustment_out',
      'opening',
    ]);
    expect(card.movements[0]!.documentNumber).toBe(out7.docNumber);
  });

  it('the storekeeper adjusts quantities but never sees or types a value (decision 0040)', async () => {
    const it2 = await item('ADJ-T002', '10000');
    await adjust(owner, {
      kind: 'opening',
      reasonCodeId: ids.opening,
      lines: [{ itemId: it2.id, quantityMilli: '5000' }],
    });
    const r = await adjust(storekeeper, {
      kind: 'decrease',
      reasonCodeId: ids.damaged,
      lines: [{ itemId: it2.id, quantityMilli: '1000' }],
    });
    expect(r.statusCode).toBe(201);
    const doc = r.json<AdjustmentDetail>();
    expect('totalValueFils' in doc).toBe(false);
    expect('valueFils' in doc.lines[0]!).toBe(false);
    expect(
      await refusal(
        adjust(storekeeper, {
          kind: 'increase',
          reasonCodeId: ids.found,
          lines: [{ itemId: it2.id, quantityMilli: '1000', unitCost4dp: '1' }],
        }),
      ),
    ).toMatchObject({ status: 403, permission: 'stock.view_cost' });
    const card = (
      await storekeeper('GET', `/api/v1/items/${it2.id}/stock`)
    ).json<ItemStockResponse>();
    expect(Object.keys(card.balances[0]!).sort()).toEqual([
      'quantityMilli',
      'stockStatus',
      'warehouseId',
    ]);
    expect(card.balances[0]!.quantityMilli).toBe('4000');
    expect('value4dp' in card.movements[0]!).toBe(false);
    // The cashier has no stock screens at all.
    expect((await cashier('GET', `/api/v1/items/${it2.id}/stock`)).statusCode).toBe(403);
  });

  it('above 500.00 AED needs a supervisor approval (decision 0041); more stock is valued at the average', async () => {
    const it3 = await item('ADJ-T003');
    await adjust(owner, {
      kind: 'opening',
      reasonCodeId: ids.opening,
      lines: [{ itemId: it3.id, quantityMilli: '1000', unitCost4dp: '1000000' }],
    }); // 100.00
    const body = {
      kind: 'increase',
      reasonCodeId: ids.found,
      lines: [{ itemId: it3.id, quantityMilli: '6000' }],
    }; // 6 × 100.00
    expect(await refusal(adjust(storekeeper, body))).toMatchObject({
      status: 403,
      rule: 'APPROVAL_REQUIRED',
    });
    const approval = await withBusinessTx(
      server.db,
      { userId: storekeeperId, deviceId: storekeeperPc.id, requestId: randomUUID() },
      async (trx) =>
        (
          await sql<{
            id: string;
          }>`INSERT INTO auth.approvals (permission_code, approved_by, reason_text)
                                    VALUES ('stock.adjust_over_threshold', ${accountantId}, 'Found a full box')
                                    RETURNING id::text`.execute(trx)
        ).rows[0]!.id,
    );
    const ok = await adjust(storekeeper, { ...body, approvalId: approval });
    expect(ok.statusCode).toBe(201);
    // The same approval cannot be used twice.
    expect(
      (await adjust(storekeeper, { ...body, approvalId: approval })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    const card = (await owner('GET', `/api/v1/items/${it3.id}/stock`)).json<ItemStockResponse>();
    expect(card.balances[0]).toMatchObject({ quantityMilli: '7000', value4dp: '7000000' });
  });

  it('moving to defective and writing off post rows 14 and 15; more than on hand is refused', async () => {
    const it4 = await item('ADJ-T004');
    await adjust(owner, {
      kind: 'opening',
      reasonCodeId: ids.opening,
      lines: [{ itemId: it4.id, quantityMilli: '4000', unitCost4dp: '250000' }],
    });
    const moved = (
      await adjust(storekeeper, {
        kind: 'status_change',
        reasonCodeId: ids.broken,
        lines: [{ itemId: it4.id, quantityMilli: '1000' }],
      })
    ).json<AdjustmentDetail>();
    expect(moved.lines[0]).toMatchObject({ stockStatus: 'available', targetStatus: 'defective' });
    expect(await entryOf(moved)).toEqual({ '1320': ['2500', '0'], '1310': ['0', '2500'] });
    // Writing off defective goods (the default storekeeper role may do it).
    const writeOff = {
      kind: 'write_off',
      reasonCodeId: ids.scrapped,
      lines: [{ itemId: it4.id, quantityMilli: '1000' }],
    };
    expect((await adjust(storekeeper, writeOff)).statusCode).toBe(201); // storekeeper role has stock.write_off by default
    expect(
      await refusal(
        adjust(owner, {
          kind: 'decrease',
          reasonCodeId: ids.damaged,
          lines: [{ itemId: it4.id, quantityMilli: '9000' }],
        }),
      ),
    ).toMatchObject({ status: 422, rule: 'STOCK_INSUFFICIENT' });
    const list = (
      await owner('GET', `/api/v1/stock/adjustments?itemId=${it4.id}&kind=write_off`)
    ).json<AdjustmentsResponse>();
    expect(list.adjustments).toHaveLength(1);
    expect(
      await entryOf(
        (
          await owner('GET', `/api/v1/stock/adjustments/${list.adjustments[0]!.id}`)
        ).json<AdjustmentDetail>(),
      ),
    ).toEqual({
      '5700': ['2500', '0'],
      '1320': ['0', '2500'],
    });
  });

  it('nothing is dated in a closed month', async () => {
    const it5 = await item('ADJ-T005', '100');
    const jan = await sql<{ id: string; d: string; v: number }>`
      SELECT id::text, period_start::text AS d, row_version AS v FROM gl.periods ORDER BY period_start LIMIT 1`.execute(
      server.db,
    );
    const period = jan.rows[0]!;
    expect(
      (await owner('POST', `/api/v1/periods/${period.id}/close`, { rowVersion: period.v }))
        .statusCode,
    ).toBe(200);
    expect(
      await refusal(
        adjust(owner, {
          kind: 'opening',
          date: period.d,
          reasonCodeId: ids.opening,
          lines: [{ itemId: it5.id, quantityMilli: '1000' }],
        }),
      ),
    ).toMatchObject({ status: 422, rule: 'PERIOD_NOT_OPEN' });
  });
});

describe('counts (blind — decision 0044)', () => {
  it('the counter never sees the system quantity; the reviewer posts the differences with reasons', async () => {
    const a = await item('CNT-T001', '10000'); // 1.00
    const b = await item('CNT-T002', '20000'); // 2.00
    await adjust(owner, {
      kind: 'opening',
      reasonCodeId: ids.opening,
      lines: [
        { itemId: a.id, quantityMilli: '10000' },
        { itemId: b.id, quantityMilli: '5000' },
      ],
    });
    const created = await storekeeper('POST', '/api/v1/stock/counts', {
      scope: 'selected',
      itemIds: [a.id, b.id],
    });
    expect(created.statusCode).toBe(201);
    let count = created.json<CountDetail>();
    expect(count.review).toBe(true); // the storekeeper also has stock.count_post by default
    const lineOf = (c: CountDetail, itemId: string) => c.lines.find((l) => l.itemId === itemId)!;
    // Someone who counts but may not post (no stock.count_post) counts blind.
    await withBusinessTx(server.db, { userId: 1n, requestId: randomUUID() }, async (trx) => {
      await sql`INSERT INTO auth.roles (code, name_ar, name_en) VALUES ('counter', 'عدّاد', 'Counter')`.execute(
        trx,
      );
      await sql`INSERT INTO auth.role_permissions (role_id, permission_code)
                SELECT r.id, p FROM auth.roles r, unnest(ARRAY['stock.view', 'stock.count']) p WHERE r.code = 'counter'`.execute(
        trx,
      );
    });
    const blind = await signedIn('blind.inv', ['counter']);
    const seen = (await blind.act('GET', `/api/v1/stock/counts/${count.id}`)).json<CountDetail>();
    expect(seen.review).toBe(false);
    expect('systemMilli' in seen.lines[0]!).toBe(false);

    // Counted: 9 of A (one missing), 5 of B.
    count = (
      await blind.act('PUT', `/api/v1/stock/counts/${count.id}/lines`, {
        lines: [
          { lineId: lineOf(count, a.id).id, countedMilli: '9000' },
          { lineId: lineOf(count, b.id).id, countedMilli: '5000' },
        ],
      })
    ).json<CountDetail>();
    expect(
      (
        await blind.act('POST', `/api/v1/stock/counts/${count.id}/post`, {
          rowVersion: count.rowVersion,
        })
      ).statusCode,
    ).toBe(403);

    const review = (await owner('GET', `/api/v1/stock/counts/${count.id}`)).json<CountDetail>();
    expect(lineOf(review, a.id)).toMatchObject({ systemMilli: '10000', varianceMilli: '-1000' });
    expect(lineOf(review, b.id)).toMatchObject({ varianceMilli: '0' });
    expect(
      await refusal(
        owner('POST', `/api/v1/stock/counts/${count.id}/post`, { rowVersion: review.rowVersion }),
      ),
    ).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    const posted = await owner('POST', `/api/v1/stock/counts/${count.id}/post`, {
      rowVersion: review.rowVersion,
      reasons: [
        {
          lineId: lineOf(review, a.id).id,
          reasonCodeId: countReason.loss,
          note: 'Not on the shelf',
        },
      ],
    });
    expect(posted.statusCode).toBe(200);
    const done = posted.json<CountDetail>();
    expect(done).toMatchObject({ status: 'posted', totalValueFils: '-100' });
    expect(done.docNumber).toMatch(/^CNT-/);
    const card = (await owner('GET', `/api/v1/items/${a.id}/stock`)).json<ItemStockResponse>();
    expect(card.balances[0]).toMatchObject({ quantityMilli: '9000' });
    expect(card.movements[0]).toMatchObject({
      movementType: 'count_loss',
      documentNumber: done.docNumber,
    });
    const journal = (
      await owner('GET', '/api/v1/journal?source=inventory_count')
    ).json<JournalResponse>();
    expect(journal.entries[0]).toMatchObject({ sourceNumber: done.docNumber, totalFils: '100' });
  });
});

describe('stock figures, oversell review and the journal', () => {
  it('the item list shows quantities to all and the average cost only with stock.view_cost; "to reorder" filters', async () => {
    const low = await item('FIG-0001', '10000'); // reorder level 5
    await adjust(owner, {
      kind: 'opening',
      reasonCodeId: ids.opening,
      lines: [{ itemId: low.id, quantityMilli: '2000' }],
    });
    const forOwner = (
      await owner('GET', '/api/v1/items?toReorder=true&q=FIG-0001')
    ).json<ItemsResponse>();
    expect(forOwner.items[0]!.stock).toEqual({
      onHandMilli: '2000',
      defectiveMilli: '0',
      reorderLevelMilli: '5000',
      toReorder: true,
      avgUnitCost4dp: '10000',
    });
    const forCashier = (await cashier('GET', '/api/v1/items?q=FIG-0001')).json<ItemsResponse>();
    expect(forCashier.items[0]!.stock).toEqual({
      onHandMilli: '2000',
      defectiveMilli: '0',
      reorderLevelMilli: '5000',
      toReorder: true,
    });
    const summary = (await owner('GET', '/api/v1/stock/summary')).json<StockSummary>();
    expect(summary.toReorder).toBeGreaterThan(0);
    expect(summary.valueFils).toMatch(/^\d+$/);
    expect(
      'valueFils' in (await storekeeper('GET', '/api/v1/stock/summary')).json<StockSummary>(),
    ).toBe(false);
  });

  it('an oversell is reviewed once, with a note, by someone with stock.oversell_review', async () => {
    const o = await item('OVS-0001', '30000');
    const oversellId = await withBusinessTx(
      server.db,
      { userId: storekeeperId, deviceId: storekeeperPc.id, requestId: randomUUID() },
      async (trx) => {
        const approval = (
          await sql<{
            id: bigint;
          }>`INSERT INTO auth.approvals (permission_code, approved_by, reason_text)
                                    VALUES ('pos.oversell', ${accountantId}, 'Customer waiting') RETURNING id`.execute(
            trx,
          )
        ).rows[0]!.id;
        const doc = (
          await sql<{
            id: bigint;
          }>`INSERT INTO inv.adjustments (kind, warehouse_id, adjustment_date, reason_code_id, approval_id, sales_document_id)
            SELECT 'oversell', w.id, sys.business_date(), r.id, ${approval}, 1 FROM md.warehouses w, sys.reason_codes r
             WHERE w.code = 'MAIN' AND r.category = 'oversell' RETURNING id`.execute(trx)
        ).rows[0]!.id;
        const line = (
          await sql<{
            id: bigint;
          }>`INSERT INTO inv.adjustment_lines (adjustment_id, line_no, item_id, quantity, entered_unit_cost_4dp)
            VALUES (${doc}, 1, ${BigInt(o.id)}, 1, 30000) RETURNING id`.execute(trx)
        ).rows[0]!.id;
        await sql`INSERT INTO inv.movements (movement_type, movement_date, item_id, warehouse_id, stock_status, quantity, value_4dp, adjustment_line_id)
          SELECT 'oversell_in', sys.business_date(), ${BigInt(o.id)}, w.id, 'available', 1, 30000, ${line} FROM md.warehouses w WHERE w.code = 'MAIN'`.execute(
          trx,
        );
        await sql`UPDATE inv.adjustments SET status = 'posted', total_value_fils = 300 WHERE id = ${doc}`.execute(
          trx,
        );
        // The POS (M5) posts the oversell's entry in the same transaction (posting map row 12).
        await postEntry(trx, {
          date: (await sql<{ d: string }>`SELECT sys.business_date()::text AS d`.execute(trx))
            .rows[0]!.d,
          source: { type: 'inventory_adjustment', id: doc },
          amounts: stockPosting('oversell', [{ stockStatus: 'available', valueFils: 300n }]),
        });
        return doc.toString();
      },
    );
    const pending = (
      await storekeeper('GET', '/api/v1/stock/adjustments?review=pending')
    ).json<AdjustmentsResponse>();
    const target = pending.adjustments.find((a) => a.id === oversellId)!;
    expect(target.reviewStatus).toBe('pending');
    expect(
      (
        await cashier('POST', `/api/v1/stock/adjustments/${oversellId}/review`, {
          note: 'ok ok',
          rowVersion: target.rowVersion,
        })
      ).statusCode,
    ).toBe(403);
    const reviewed = (
      await storekeeper('POST', `/api/v1/stock/adjustments/${oversellId}/review`, {
        note: 'Shelf miscounted',
        rowVersion: target.rowVersion,
      })
    ).json<AdjustmentDetail>();
    expect(reviewed).toMatchObject({ reviewStatus: 'reviewed', reviewNote: 'Shelf miscounted' });
  });

  it('the journal and the trial balance balance; only with ledger.view', async () => {
    const list = (
      await accountant('GET', '/api/v1/journal?source=inventory_adjustment')
    ).json<JournalResponse>();
    expect(list.total).toBeGreaterThan(5);
    const { rows } = await sql<{ d: string }>`SELECT sys.business_date()::text AS d`.execute(
      server.db,
    );
    const tb = (
      await accountant(
        'GET',
        `/api/v1/trial-balance?from=${rows[0]!.d.slice(0, 8)}01&to=${rows[0]!.d}`,
      )
    ).json<TrialBalanceResponse>();
    expect(tb.totalDebitFils).toBe(tb.totalCreditFils);
    // The inventory accounts equal the stock books exactly.
    const books = await sql<{ available: string; defective: string }>`
      SELECT coalesce(sum(book_value_fils) FILTER (WHERE stock_status = 'available'), 0)::text AS available,
             coalesce(sum(book_value_fils) FILTER (WHERE stock_status = 'defective'), 0)::text AS defective
        FROM inv.balances`.execute(server.db);
    const balanceOf = (code: string) => tb.rows.find((r) => r.code === code)?.balanceFils ?? '0';
    expect(balanceOf('1310')).toBe(books.rows[0]!.available);
    expect(balanceOf('1320')).toBe(books.rows[0]!.defective);
    expect((await storekeeper('GET', '/api/v1/journal')).statusCode).toBe(403);
  });
});
