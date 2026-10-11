/**
 * M2 T6–T7: items with one price and a "price includes VAT" switch (decision 0032), kits and
 * barcodes; customers with types, unique phones/TRNs and cash-first credit (0036, 0037);
 * suppliers and the lists (0034). Permissions are checked on the server; every save is versioned.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CategoryItem,
  CustomerDetail,
  CustomersResponse,
  FilePayload,
  ItemDetail,
  ItemsResponse,
  PaymentMethodItem,
  SupplierDetail,
  UnitItem,
  VatResponse,
  WarehouseItem,
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
let accountant: Actor;
let cashier: Actor;
let storekeeper: Actor;
let clerk: Actor;

function actor(device: TestDevice, token: string): Actor {
  return (method, url, body) =>
    call(server, method, url, {
      device,
      token,
      ...(method === 'GET' ? {} : { idempotencyKey: randomUUID() }),
      ...(body !== undefined ? { body } : {}),
    });
}

async function signedIn(username: string, roles: string[]): Promise<Actor> {
  const pc = await addDevice(server, { code: `PC-${username}` });
  const id = await addUser(server, { username, roles });
  return actor(pc, (await openSession(server, { userId: id, deviceId: pc.id })).token);
}

async function refusal(response: ReturnType<typeof call>) {
  const r = await response;
  const body = r.json<{ error: { code: string; details: Record<string, unknown> } }>();
  return { status: r.statusCode, code: body.error?.code, ...body.error?.details };
}

const ids = { category: '', unit: '', kgUnit: '', vat: '', zeroVat: '', service: '' };

beforeAll(async () => {
  server = await startTestServer();
  const office = await addDevice(server, { code: 'OFFICE-01' });
  const ownerId = await addOwner(server);
  owner = actor(
    office,
    (await openSession(server, { userId: ownerId, deviceId: office.id, method: 'password_totp' }))
      .token,
  );
  accountant = await signedIn('acc.two', ['accountant']);
  cashier = await signedIn('cash.two', ['cashier']);
  storekeeper = await signedIn('store.two', ['storekeeper']);
  // A role that may manage items but not prices.
  await withBusinessTx(server.db, { userId: 1n, requestId: randomUUID() }, async (trx) => {
    await sql`INSERT INTO auth.roles (code, name_ar, name_en) VALUES ('item-clerk', 'كاتب أصناف', 'Item clerk')`.execute(
      trx,
    );
    await sql`INSERT INTO auth.role_permissions (role_id, permission_code)
              SELECT r.id, p FROM auth.roles r, unnest(ARRAY['items.view', 'items.manage']) p
               WHERE r.code = 'item-clerk'`.execute(trx);
  });
  clerk = await signedIn('clerk.two', ['item-clerk']);

  const categories = (await owner('GET', '/api/v1/item-categories')).json<{
    categories: CategoryItem[];
  }>().categories;
  ids.category = categories.find((c) => c.code === 'EQUIP')!.id;
  ids.service = categories.find((c) => c.code === 'SERV')!.id;
  const units = (await owner('GET', '/api/v1/units')).json<{ units: UnitItem[] }>().units;
  ids.unit = units.find((u) => u.code === 'PCS')!.id;
  ids.kgUnit = units.find((u) => u.code === 'KG')!.id;
  const vat = (await owner('GET', '/api/v1/settings/vat')).json<VatResponse>().categories;
  ids.vat = vat.find((v) => v.code === 'SR')!.id;
  ids.zeroVat = vat.find((v) => v.code === 'ZR')!.id;
});
afterAll(() => server.close());

const pump = () => ({
  code: 'equip-0001',
  itemType: 'stock',
  nameAr: 'مضخة أرضية',
  nameEn: 'Floor pump',
  categoryId: ids.category,
  unitId: ids.unit,
  vatCategoryId: ids.vat,
  reorderLevelMilli: '5000',
  price: { price4dp: '1250000', includesVat: true },
  barcodes: [{ barcode: '6291234567890' }],
});

describe('items (design 07, decision 0032)', () => {
  let pumpItem: ItemDetail;

  it('are created with one price, its VAT switch and a barcode; the code is stored in capitals', async () => {
    const created = await owner('POST', '/api/v1/items', pump());
    expect(created.statusCode).toBe(201);
    pumpItem = created.json<ItemDetail>();
    expect(pumpItem).toMatchObject({
      code: 'EQUIP-0001',
      price: { price4dp: '1250000', includesVat: true },
      primaryBarcode: '6291234567890',
      reorderLevelMilli: '5000',
      rowVersion: 1,
    });
  });

  it('suggest the next code in the category', async () => {
    expect(
      (await owner('GET', `/api/v1/items/next-code?categoryId=${ids.category}`)).json(),
    ).toEqual({ code: 'EQUIP-0002' });
  });

  it('are found by Arabic letter variants, by code and by barcode', async () => {
    for (const q of ['مضخه ارضيه', 'floor', 'equip-0001', '6291234567890']) {
      const list = (
        await storekeeper('GET', `/api/v1/items?q=${encodeURIComponent(q)}`)
      ).json<ItemsResponse>();
      expect(list.items.map((i) => i.code)).toEqual(['EQUIP-0001']);
    }
  });

  it('need a price above zero when for sale, and the unit’s decimals', async () => {
    expect(
      await refusal(
        owner('POST', '/api/v1/items', {
          ...pump(),
          code: 'EQUIP-0003',
          price: null,
          barcodes: [],
        }),
      ),
    ).toMatchObject({ status: 422, code: 'RULE_VIOLATION', rule: 'PRICE_REQUIRED' });
    expect(
      await refusal(
        owner('POST', '/api/v1/items', {
          ...pump(),
          code: 'EQUIP-0003',
          reorderLevelMilli: '1500',
          barcodes: [],
        }),
      ),
    ).toMatchObject({ status: 422, code: 'RULE_VIOLATION', rule: 'QUANTITY_DECIMALS' });
    expect(
      await refusal(owner('POST', '/api/v1/items', { ...pump(), code: 'EQUIP-0003' })),
    ).toMatchObject({ status: 409, code: 'DUPLICATE', field: 'barcodes' });
  });

  it('are changed only by people with items.manage; a price change also needs prices.manage', async () => {
    expect(
      await refusal(storekeeper('POST', '/api/v1/items', { ...pump(), code: 'X-1' })),
    ).toMatchObject({
      status: 403,
    });
    const renamed = await clerk('PUT', `/api/v1/items/${pumpItem.id}`, {
      ...pump(),
      nameEn: 'Floor pump 1 HP',
      rowVersion: pumpItem.rowVersion,
    });
    expect(renamed.statusCode).toBe(200);
    const current = renamed.json<ItemDetail>();
    expect(
      await refusal(
        clerk('PUT', `/api/v1/items/${pumpItem.id}`, {
          ...pump(),
          price: { price4dp: '1300000', includesVat: true },
          rowVersion: current.rowVersion,
        }),
      ),
    ).toMatchObject({ status: 403, code: 'PERMISSION_DENIED', permission: 'prices.manage' });
    pumpItem = (
      await owner('PUT', `/api/v1/items/${pumpItem.id}`, {
        ...pump(),
        price: { price4dp: '1300000', includesVat: false },
        rowVersion: current.rowVersion,
      })
    ).json<ItemDetail>();
    expect(pumpItem.price).toEqual({ price4dp: '1300000', includesVat: false });
  });

  it('refuse a save over someone else’s ("changed by someone else")', async () => {
    expect(
      await refusal(owner('PUT', `/api/v1/items/${pumpItem.id}`, { ...pump(), rowVersion: 1 })),
    ).toMatchObject({ status: 409, code: 'STALE_VERSION' });
  });

  it('kits list their components, which then keep their type', async () => {
    const visit = (
      await owner('POST', '/api/v1/items', {
        code: 'SERV-0001',
        itemType: 'service',
        nameAr: 'زيارة تركيب',
        nameEn: 'Installation visit',
        categoryId: ids.service,
        unitId: ids.unit,
        vatCategoryId: ids.vat,
        price: { price4dp: '1500000', includesVat: false },
      })
    ).json<ItemDetail>();
    const kit = (
      await owner('POST', '/api/v1/items', {
        code: 'KIT-0001',
        itemType: 'bundle',
        nameAr: 'طقم مضخة مع التركيب',
        nameEn: 'Pump with installation',
        categoryId: ids.category,
        unitId: ids.unit,
        vatCategoryId: ids.vat,
        price: { price4dp: '2500000', includesVat: true },
        components: [
          { itemId: pumpItem.id, quantityMilli: '1000' },
          { itemId: visit.id, quantityMilli: '2000' },
        ],
      })
    ).json<ItemDetail>();
    expect(kit.components.map((c) => [c.code, c.quantityMilli])).toEqual([
      ['EQUIP-0001', '1000'],
      ['SERV-0001', '2000'],
    ]);
    expect(
      await refusal(
        owner('PUT', `/api/v1/items/${visit.id}`, {
          code: 'SERV-0001',
          itemType: 'stock',
          nameAr: 'زيارة',
          nameEn: 'Visit',
          categoryId: ids.service,
          unitId: ids.unit,
          vatCategoryId: ids.vat,
          price: { price4dp: '1500000', includesVat: false },
          rowVersion: visit.rowVersion,
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'ITEM_TYPE_FIXED', why: 'kit_component' });
    const smaller = (
      await owner('PUT', `/api/v1/items/${kit.id}`, {
        itemType: 'bundle',
        nameAr: kit.nameAr,
        nameEn: kit.nameEn,
        categoryId: ids.category,
        unitId: ids.unit,
        vatCategoryId: ids.vat,
        price: { price4dp: '2500000', includesVat: true },
        components: [{ itemId: pumpItem.id, quantityMilli: '1000' }],
        rowVersion: kit.rowVersion,
      })
    ).json<ItemDetail>();
    expect(smaller.components.map((c) => c.code)).toEqual(['EQUIP-0001']);
  });

  it('are deactivated with a reason, then hidden from the active list', async () => {
    const extra = (
      await owner('POST', '/api/v1/items', {
        ...pump(),
        code: 'EQUIP-0009',
        barcodes: [],
        reorderLevelMilli: null,
      })
    ).json<ItemDetail>();
    expect(
      await refusal(owner('POST', `/api/v1/items/${extra.id}/deactivate`, { rowVersion: 1 })),
    ).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    await owner('POST', `/api/v1/items/${extra.id}/deactivate`, {
      reason: 'Duplicate entry',
      rowVersion: 1,
    });
    const active = (await owner('GET', '/api/v1/items?q=EQUIP-0009')).json<ItemsResponse>();
    expect(active.items).toEqual([]);
    const inactive = (
      await owner('GET', '/api/v1/items?q=EQUIP-0009&status=inactive')
    ).json<ItemsResponse>();
    expect(inactive.items.map((i) => i.code)).toEqual(['EQUIP-0009']);
  });
});

describe('customers (design 14, decisions 0032, 0036, 0037)', () => {
  let customer: CustomerDetail;
  const base = {
    customerType: 'contractor',
    name: 'مؤسسة البناء الحديث',
    phone: '050 123 4567',
    isVatRegistered: false,
  };

  it('are added by the cashier, always as cash, with the phone in international form', async () => {
    const created = await cashier('POST', '/api/v1/customers', base);
    expect(created.statusCode).toBe(201);
    customer = created.json<CustomerDetail>();
    expect(customer).toMatchObject({
      code: expect.stringMatching(/^C\d{5}$/) as unknown,
      phone: '+971501234567',
      customerType: 'contractor',
      creditMode: 'cash',
      creditLimitFils: '0',
      paymentTermsDays: 0,
    });
  });

  it('refuse a shared phone or TRN and a wrong TRN', async () => {
    expect(
      await refusal(cashier('POST', '/api/v1/customers', { ...base, name: 'Other' })),
    ).toMatchObject({ status: 409, code: 'DUPLICATE', field: 'phone' });
    expect(
      await refusal(
        cashier('POST', '/api/v1/customers', {
          ...base,
          phone: '0502222222',
          isVatRegistered: true,
          trn: '2001',
        }),
      ),
    ).toMatchObject({ status: 422, issues: [{ path: ['trn'], code: 'invalid_trn' }] });
    await cashier('POST', '/api/v1/customers', {
      ...base,
      customerType: 'company',
      name: 'Al Ain Hotel',
      phone: '0502222222',
      isVatRegistered: true,
      trn: '100-1234-5678-9012',
    });
    expect(
      await refusal(
        cashier('POST', '/api/v1/customers', {
          ...base,
          name: 'Copy',
          phone: '0503333333',
          isVatRegistered: true,
          trn: '100123456789012',
        }),
      ),
    ).toMatchObject({ status: 409, code: 'DUPLICATE', field: 'trn' });
  });

  it('get credit only from someone with customers.credit, with a reason', async () => {
    const credit = { mode: 'credit', creditLimitFils: '500000', paymentTermsDays: 30 };
    expect(
      await refusal(
        cashier('POST', `/api/v1/customers/${customer.id}/credit`, {
          credit,
          reason: 'Good',
          rowVersion: customer.rowVersion,
        }),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await refusal(
        accountant('POST', `/api/v1/customers/${customer.id}/credit`, {
          credit,
          rowVersion: customer.rowVersion,
        }),
      ),
    ).toMatchObject({ status: 422 });
    customer = (
      await accountant('POST', `/api/v1/customers/${customer.id}/credit`, {
        credit,
        reason: 'Contractor for 5 years',
        rowVersion: customer.rowVersion,
      })
    ).json<CustomerDetail>();
    expect(customer).toMatchObject({
      creditMode: 'credit',
      creditLimitFils: '500000',
      paymentTermsDays: 30,
    });
    const { rows } = await server.admin.query<{ reason: string }>(
      `SELECT reason FROM audit.log WHERE entity_type = 'md.customers' AND entity_id = $1 AND action = 'update'`,
      [customer.id],
    );
    expect(rows).toEqual([{ reason: 'Contractor for 5 years' }]);
  });

  it('keep the walk-in "Cash customer" locked', async () => {
    const list = (await cashier('GET', '/api/v1/customers')).json<CustomersResponse>();
    const walkIn = list.customers[0]!;
    expect(walkIn).toMatchObject({ isWalkIn: true, name: 'عميل نقدي' });
    expect(
      await refusal(
        owner('PUT', `/api/v1/customers/${walkIn.id}`, {
          ...base,
          phone: '0509999999',
          rowVersion: 1,
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'WALK_IN_LOCKED' });
    expect(list.counts).toEqual({ active: 3, vatRegistered: 1 });
  });

  it('are found by name variants and by a local phone number', async () => {
    for (const q of ['مؤسسه البناء', '0501234567', '050 123 4567']) {
      const found = (
        await cashier('GET', `/api/v1/customers?q=${encodeURIComponent(q)}`)
      ).json<CustomersResponse>();
      expect(found.customers.map((c) => c.id)).toEqual([customer.id]);
    }
  });

  it('are exported to Excel only with data.export, and the export is audited', async () => {
    expect((await cashier('GET', '/api/v1/customers/export')).statusCode).toBe(403);
    const file = (await owner('GET', '/api/v1/customers/export')).json<FilePayload>();
    expect(file.fileName).toBe('artepool-customers.xlsx');
    expect(Buffer.from(file.dataBase64, 'base64').subarray(0, 2).toString()).toBe('PK');
    const { rows } = await server.admin.query<{ data: { entity: string; rows: number } }>(
      `SELECT new_values AS data FROM audit.log WHERE action = 'event:data.exported'`,
    );
    expect(rows.map((r) => r.data)).toEqual([{ entity: 'customers', rows: 3 }]);
  });
});

describe('suppliers and the lists (decision 0034)', () => {
  it('suppliers follow the TRN rule and get a code', async () => {
    const supplier = (
      await owner('POST', '/api/v1/suppliers', {
        name: 'Gulf Pool Chemicals LLC',
        isVatRegistered: true,
        trn: '100999999999999',
        paymentTermsDays: 45,
      })
    ).json<SupplierDetail>();
    expect(supplier.code).toMatch(/^S\d{5}$/);
    const listed = (await owner('GET', '/api/v1/suppliers?q=Gulf Pool')).json<{
      suppliers: SupplierDetail[];
    }>().suppliers;
    expect(listed.find((s) => s.id === supplier.id)?.paymentTermsDays).toBe(45);
    expect((await cashier('GET', '/api/v1/suppliers')).statusCode).toBe(403);
  });

  it('payment methods post to an asset account', async () => {
    const accounts = (await owner('GET', '/api/v1/accounts')).json<{
      accounts: { id: string; code: string }[];
    }>().accounts;
    const account = (code: string) => accounts.find((a) => a.code === code)!.id;
    const body = {
      code: 'TABBY',
      kind: 'other',
      nameAr: 'تابي',
      nameEn: 'Tabby',
      opensDrawer: false,
      givesChange: false,
      requiresReference: true,
      inPos: true,
      inOffice: true,
    };
    expect(
      await refusal(
        owner('POST', '/api/v1/payment-methods', { ...body, glAccountId: account('4100') }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'PAYMENT_ACCOUNT_INVALID' });
    const created = (
      await owner('POST', '/api/v1/payment-methods', { ...body, glAccountId: account('1230') })
    ).json<PaymentMethodItem>();
    expect(created.code).toBe('TABBY');
  });

  it('one default warehouse, which moves when another is chosen', async () => {
    const shop = (
      await owner('POST', '/api/v1/warehouses', {
        code: 'shop-2',
        nameAr: 'المعرض',
        nameEn: 'Showroom',
        warehouseType: 'store',
      })
    ).json<WarehouseItem>();
    const after = (
      await owner('POST', `/api/v1/warehouses/${shop.id}/make-default`, {
        rowVersion: shop.rowVersion,
      })
    ).json<{ warehouses: WarehouseItem[] }>().warehouses;
    expect(after.filter((w) => w.isDefault).map((w) => w.code)).toEqual(['SHOP-2']);
  });

  it('units in use stay active; units and categories need items.manage', async () => {
    const pcs = (await owner('GET', '/api/v1/units'))
      .json<{ units: UnitItem[] }>()
      .units.find((u) => u.code === 'PCS')!;
    expect(
      await refusal(
        owner('POST', `/api/v1/units/${pcs.id}/deactivate`, {
          reason: 'Not used',
          rowVersion: pcs.rowVersion,
        }),
      ),
    ).toMatchObject({ code: 'RULE_VIOLATION', rule: 'STILL_USED' });
    expect(
      (
        await cashier('POST', '/api/v1/units', {
          code: 'ROLL',
          nameAr: 'لفة',
          nameEn: 'Roll',
          decimals: 0,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await owner('POST', '/api/v1/units', {
          code: 'roll',
          nameAr: 'لفة',
          nameEn: 'Roll',
          decimals: 0,
        })
      ).json<UnitItem>().code,
    ).toBe('ROLL');
  });
});
