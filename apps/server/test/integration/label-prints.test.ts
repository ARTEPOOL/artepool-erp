/**
 * Label prints through the API (decision 0099): items for labels (price, VAT rate, unit, quantity on
 * hand); every print recorded with the price on the label, audited, with who and which PC; a print
 * whose price changed meanwhile is not recorded (the database refuses it too); the "price changed,
 * label is old" list follows the price, "price includes VAT", the VAT category and its rate, can be
 * filtered by category, and an item leaves it once printed with its new price. Only people who
 * print labels may do any of it.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ItemDetail,
  LabelDesignResponse,
  LabelItemsResponse,
  PriceChangedResponse,
  RecordLabelPrintsResponse,
  VatResponse,
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
type Actor = (method: Method, url: string, body?: unknown) => ReturnType<typeof call>;

let server: TestServer;
let owner: Actor;
let storekeeper: Actor;
let technician: Actor;
let storeDevice: TestDevice;
const ids: Record<string, string> = {};
let designVersionId = '';

function actor(device: TestDevice, token: string): Actor {
  return (method, url, body) =>
    call(server, method, url, {
      device,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
}

async function ok<T>(response: ReturnType<typeof call>, status = 200): Promise<T> {
  const r = await response;
  if (r.statusCode !== status) throw new Error(`${r.statusCode}: ${r.body}`);
  return r.json<T>();
}

async function newItem(
  code: string,
  opts: { category: string; unit: string; price: string; includesVat: boolean; qty?: string },
) {
  return ok<ItemDetail>(
    owner('POST', '/api/v1/items', {
      code,
      itemType: 'stock',
      nameAr: `صنف ${code}`,
      nameEn: `Item ${code}`,
      categoryId: ids[opts.category],
      unitId: ids[opts.unit],
      vatCategoryId: ids.SR,
      price: { price4dp: opts.price, includesVat: opts.includesVat },
      ...(opts.qty ? { openingStock: { quantityMilli: opts.qty, unitCost4dp: '50000' } } : {}),
    }),
    201,
  );
}

/** Saves the item with some fields changed, the way the item window does. */
async function change(id: string, patch: Partial<ItemDetail>) {
  const item = await ok<ItemDetail>(owner('GET', `/api/v1/items/${id}`));
  const next = { ...item, ...patch };
  return ok<ItemDetail>(
    owner('PUT', `/api/v1/items/${id}`, {
      itemType: next.itemType,
      nameAr: next.nameAr,
      nameEn: next.nameEn,
      descriptionAr: next.descriptionAr,
      descriptionEn: next.descriptionEn,
      packAr: next.packAr,
      packEn: next.packEn,
      categoryId: next.categoryId,
      unitId: next.unitId,
      vatCategoryId: next.vatCategoryId,
      defaultBusinessLineId: next.defaultBusinessLineId,
      reorderLevelMilli: next.reorderLevelMilli,
      reorderQtyMilli: next.reorderQtyMilli,
      isSellable: next.isSellable,
      price: next.price,
      barcodes: [],
      components: [],
      rowVersion: item.rowVersion,
    }),
  );
}

const line = (item: ItemDetail, copies: number, rateBp = 500) => ({
  itemId: item.id,
  copies,
  price: item.price ? { ...item.price, rateBp } : null,
});

const record = (who: Actor, lines: unknown[], source = 'list') =>
  who('POST', '/api/v1/label-prints', {
    sizeId: ids.size,
    designVersionId,
    source,
    lines,
  });

const changedList = async (categoryId?: string) =>
  (
    await ok<PriceChangedResponse>(
      owner(
        'GET',
        `/api/v1/label-prints/price-changed${categoryId ? `?categoryId=${categoryId}` : ''}`,
      ),
    )
  ).items;

const printCount = async () =>
  (await server.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM inv.label_prints'))
    .rows[0]!.n;

beforeAll(async () => {
  server = await startTestServer();
  const office = await addDevice(server, { code: 'OFFICE-LABELS' });
  const ownerId = await addOwner(server);
  owner = actor(
    office,
    (await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' }))
      .token,
  );
  storeDevice = await addDevice(server, { code: 'STORE-LABELS', kind: 'warehouse' });
  const keeperId = await addUser(server, { username: 'keeper.labels', roles: ['storekeeper'] });
  storekeeper = actor(
    storeDevice,
    (await openSession(server, { userId: keeperId, deviceId: storeDevice.id })).token,
  );
  const techId = await addUser(server, { username: 'tech.labels', roles: ['technician'] });
  technician = actor(
    office,
    (await openSession(server, { userId: techId, deviceId: office.id })).token,
  );
  const { rows } = await sql<{ kind: string; id: string }>`
    SELECT code AS kind, id::text FROM md.item_categories WHERE code IN ('CHEM', 'EQUIP')
    UNION ALL SELECT code, id::text FROM md.units WHERE code IN ('PCS', 'KG')
    UNION ALL SELECT code, id::text FROM md.vat_categories WHERE code IN ('SR', 'ZR')
    UNION ALL SELECT 'size', id::text FROM md.label_sizes WHERE code = '50X30'
  `.execute(server.db);
  for (const r of rows) ids[r.kind] = r.id;
  designVersionId = (await ok<LabelDesignResponse>(owner('GET', '/api/v1/label-design'))).versionId;
});
afterAll(() => server.close());

describe('items for labels', () => {
  it('names, price, VAT rate, unit (pieces or weight) and quantity on hand', async () => {
    const pcs = await newItem('LBL-PCS', {
      category: 'CHEM',
      unit: 'PCS',
      price: '1200000',
      includesVat: true,
      qty: '7000',
    });
    const kg = await newItem('LBL-KG', {
      category: 'CHEM',
      unit: 'KG',
      price: '45000',
      includesVat: false,
      qty: '2500',
    });
    const { items } = await ok<LabelItemsResponse>(
      storekeeper('GET', `/api/v1/label-items?ids=${kg.id},${pcs.id}`),
    );
    expect(items.map((i) => [i.code, i.unitDecimals, i.onHandMilli, i.rateBp])).toEqual([
      ['LBL-KG', 3, '2500', 500],
      ['LBL-PCS', 0, '7000', 500],
    ]);
    expect(items[1]!.price).toEqual({ price4dp: '1200000', includesVat: true });
    // Without labels.print: refused.
    expect((await technician('GET', `/api/v1/label-items?ids=${pcs.id}`)).statusCode).toBe(403);
  });
});

describe('the print record and the "price changed" list', () => {
  it('records the price on the label, with who and which PC, in the audit log', async () => {
    const item = await newItem('LBL-REC', {
      category: 'CHEM',
      unit: 'PCS',
      price: '1000000',
      includesVat: true,
    });
    const before = await printCount();
    const saved = await ok<RecordLabelPrintsResponse>(record(storekeeper, [line(item, 3)]), 201);
    expect(saved).toEqual({ recorded: [item.id], priceChanged: [] });
    const { rows } = await server.admin.query<{
      copies: number;
      price_4dp: string;
      gross_fils: string;
      device_id: string;
      source: string;
    }>(
      `SELECT copies, price_4dp::text, gross_fils::text, device_id::text, source
         FROM inv.label_prints WHERE item_id = $1`,
      [item.id],
    );
    // 100.00 including VAT: 100.00 on the label.
    expect(rows).toEqual([
      {
        copies: 3,
        price_4dp: '1000000',
        gross_fils: '10000',
        device_id: storeDevice.id.toString(),
        source: 'list',
      },
    ]);
    expect(await printCount()).toBe(before + 1);
    const audit = await server.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.log
        WHERE entity_type = 'inv.label_prints' AND action = 'insert' AND device_id = $1`,
      [storeDevice.id.toString()],
    );
    expect(audit.rows[0]!.n).toBeGreaterThanOrEqual(1);
    // Printed with today's price: not in the list.
    expect((await changedList()).map((i) => i.code)).not.toContain('LBL-REC');
    // Without labels.print: refused, nothing recorded.
    expect((await record(technician, [line(item, 1)])).statusCode).toBe(403);
    expect(await printCount()).toBe(before + 1);
  });

  it('a new price puts the item on the list; printed with it, the item leaves the list', async () => {
    const item = await newItem('LBL-PRICE', {
      category: 'CHEM',
      unit: 'PCS',
      price: '1000000',
      includesVat: true,
      qty: '4000',
    });
    await ok(record(owner, [line(item, 4)], 'item'), 201);
    const repriced = await change(item.id, {
      price: { price4dp: '1200000', includesVat: true },
    });
    const listed = (await changedList()).find((i) => i.code === 'LBL-PRICE');
    expect(listed?.printed).toMatchObject({ price4dp: '1000000', grossFils: '10000' });
    expect(listed?.nowGrossFils).toBe('12000');
    expect(listed?.onHandMilli).toBe('4000');

    // Labels printed with the old price (the screen had not caught up): not recorded.
    const before = await printCount();
    expect(await ok<RecordLabelPrintsResponse>(record(owner, [line(item, 4)]), 201)).toEqual({
      recorded: [],
      priceChanged: [item.id],
    });
    expect(await printCount()).toBe(before);

    await ok(record(owner, [line(repriced, 4)], 'price_changed'), 201);
    expect((await changedList()).map((i) => i.code)).not.toContain('LBL-PRICE');
  });

  it('"price includes VAT", the VAT category and the VAT rate change the printed price too', async () => {
    const incl = await newItem('LBL-INCL', {
      category: 'CHEM',
      unit: 'PCS',
      price: '500000',
      includesVat: true,
    });
    const cat = await newItem('LBL-CAT', {
      category: 'EQUIP',
      unit: 'PCS',
      price: '500000',
      includesVat: false,
    });
    await ok(record(owner, [line(incl, 1), line(cat, 1)]), 201);
    await change(incl.id, { price: { price4dp: '500000', includesVat: false } });
    await change(cat.id, { vatCategoryId: ids.ZR! });
    const codes = (await changedList()).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['LBL-INCL', 'LBL-CAT']));
    // By category: equipment only.
    expect((await changedList(ids.EQUIP)).map((i) => i.code)).toEqual(['LBL-CAT']);

    // The standard rate changes (owner, with a reason): every item printed at 5% is out of date.
    const rate = await newItem('LBL-RATE', {
      category: 'CHEM',
      unit: 'PCS',
      price: '800000',
      includesVat: false,
    });
    await ok(record(owner, [line(rate, 2)]), 201);
    expect((await changedList()).map((i) => i.code)).not.toContain('LBL-RATE');
    const vat = await ok<VatResponse>(owner('GET', '/api/v1/settings/vat'));
    const sr = vat.categories.find((c) => c.code === 'SR')!;
    await ok(
      owner('PATCH', `/api/v1/settings/vat/${sr.id}`, {
        rateBp: 600,
        reason: 'test: rate change',
        rowVersion: sr.rowVersion,
      }),
    );
    const listed = (await changedList()).find((i) => i.code === 'LBL-RATE');
    expect(listed?.printed.rateBp).toBe(500);
    expect(listed?.rateBp).toBe(600);
    expect(listed?.nowGrossFils).toBe('8480');
  });

  it('the database itself refuses a record whose price is not the price now', async () => {
    const item = await newItem('LBL-DB', {
      category: 'CHEM',
      unit: 'PCS',
      price: '300000',
      includesVat: true,
    });
    const userId = (
      await server.admin.query<{ id: string }>(
        `SELECT id::text FROM auth.users WHERE username = 'owner.main'`,
      )
    ).rows[0]!.id;
    await expect(
      withBusinessTx(server.db, { userId: BigInt(userId), requestId: randomUUID() }, (trx) =>
        sql`INSERT INTO inv.label_prints (item_id, label_size_id, design_version_id, copies, source,
              price_4dp, includes_vat, vat_rate_bp, gross_fils)
            VALUES (${item.id}, ${ids.size}, ${designVersionId}, 1, 'item', 250000, true, 600, 2500)`.execute(
          trx,
        ),
      ),
    ).rejects.toMatchObject({ details: { rule: 'LABEL_PRICE_CHANGED' } });
    // Never changed or deleted.
    await expect(
      server.admin.query('DELETE FROM inv.label_prints WHERE item_id IS NOT NULL'),
    ).rejects.toThrow();
  });
});
