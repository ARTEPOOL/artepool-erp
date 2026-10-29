/**
 * A small sales setup for tests that only need to sell (the power-loss tests, M6.2 part I): the
 * owner signed in on an office PC, the company details an invoice needs, a customer, a stock item
 * with opening stock, and an A4 invoice drafted and issued with cash.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { CustomerDetail, DocumentDetail, ItemDetail } from '@artepool/shared/contracts';
import { addDevice, addOwner, call, openSession, type TestServer } from './server';

type Method = 'GET' | 'POST' | 'PUT';

export interface SalesWorld {
  /** The owner's request; a write gets a new idempotency key unless one is given. */
  owner: (
    method: Method,
    url: string,
    body?: unknown,
    idempotencyKey?: string,
  ) => ReturnType<typeof call>;
  /** A customer with an address (an A4 invoice is a full tax invoice, 0071). */
  customer: (name: string) => Promise<string>;
  /** A stock item at `price4dp`, with `quantityMilli` of opening stock at `cost4dp`. */
  stockItem: (
    code: string,
    price4dp: string,
    quantityMilli: string,
    cost4dp: string,
  ) => Promise<string>;
  draft: (customerId: string, itemId: string, quantityMilli: string) => Promise<DocumentDetail>;
  /** Issues `doc` paid in cash; the request, so a test can hold it or retry it. */
  issue: (
    doc: DocumentDetail,
    cashFils: string,
    idempotencyKey?: string,
  ) => ReturnType<typeof call>;
}

export async function ok<T>(response: ReturnType<typeof call>, status = 200): Promise<T> {
  const r = await response;
  if (r.statusCode !== status) throw new Error(`${r.statusCode}: ${r.body}`);
  return r.json<T>();
}

export async function salesWorld(server: TestServer): Promise<SalesWorld> {
  const office = await addDevice(server, { code: 'OFFICE-SALES' });
  const ownerId = await addOwner(server);
  const { token } = await openSession(server, {
    userId: ownerId,
    deviceId: office.id,
    method: 'password_totp',
  });
  const owner: SalesWorld['owner'] = (method, url, body, idempotencyKey) =>
    call(server, method, url, {
      device: office,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: idempotencyKey ?? randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
  const ids: Record<string, string> = {};
  const { rows } = await sql<{ kind: string; id: string }>`
    SELECT 'category' AS kind, id::text FROM md.item_categories WHERE code = 'PARTS'
    UNION ALL SELECT 'pcs', id::text FROM md.units WHERE code = 'PCS'
    UNION ALL SELECT 'vat', id::text FROM md.vat_categories WHERE code = 'SR'
    UNION ALL SELECT 'opening', id::text FROM sys.reason_codes WHERE category = 'other' AND code = 'OPENING'
    UNION ALL SELECT 'cash', id::text FROM md.payment_methods WHERE kind = 'cash' AND is_active
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
  let phone = 2_000_000;

  return {
    owner,
    customer: async (name) => {
      phone += 1;
      const c = await ok<CustomerDetail>(
        owner('POST', '/api/v1/customers', {
          customerType: 'company',
          name,
          phone: `050 ${phone}`,
          isVatRegistered: false,
          addressLine: 'Industrial Area 1',
        }),
        201,
      );
      return c.id;
    },
    stockItem: async (code, price4dp, quantityMilli, cost4dp) => {
      const item = await ok<ItemDetail>(
        owner('POST', '/api/v1/items', {
          code,
          itemType: 'stock',
          nameAr: `صنف ${code}`,
          nameEn: `Item ${code}`,
          categoryId: ids.category,
          unitId: ids.pcs,
          vatCategoryId: ids.vat,
          price: { price4dp, includesVat: false },
        }),
        201,
      );
      await ok(
        owner('POST', '/api/v1/stock/adjustments', {
          kind: 'opening',
          reasonCodeId: ids.opening,
          lines: [{ itemId: item.id, quantityMilli, unitCost4dp: cost4dp }],
        }),
        201,
      );
      return item.id;
    },
    draft: (customerId, itemId, quantityMilli) =>
      ok<DocumentDetail>(
        owner('POST', '/api/v1/sales/invoices', {
          customerId,
          lines: [{ itemId, quantityMilli }],
        }),
        201,
      ),
    issue: (doc, cashFils, idempotencyKey) =>
      owner(
        'POST',
        `/api/v1/sales/documents/${doc.id}/issue`,
        {
          rowVersion: doc.rowVersion,
          payments: [{ paymentMethodId: ids.cash, amountFils: cashFils }],
        },
        idempotencyKey,
      ),
  };
}
