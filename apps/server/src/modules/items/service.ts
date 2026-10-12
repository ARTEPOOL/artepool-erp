/**
 * Items & stock (design 07): stock items, services and kits, with barcodes and one sale price
 * with a "price includes VAT" switch (decision 0032). The code is suggested by the app and never
 * changes (decision 0037). Items are deactivated with a reason, never deleted.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  fitsUnitDecimals,
  nextCode,
  normalizeCode,
  quantityFromDb,
  quantityToDb,
  roundDiv,
} from '@artepool/shared';
import type {
  BarcodeItem,
  ComponentItem,
  CreateItemRequest,
  ItemDetail,
  ItemListItem,
  ItemStockFigures,
  ItemsQuery,
  ItemsResponse,
  ItemType,
  UpdateItemRequest,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { stamped } from '../../platform/db/stamped';
import { expectUpdated, fieldError } from '../../platform/db/versioned';
import { AppError, ruleError } from '../../platform/errors/app-error';
import { requireAlso } from '../../platform/permissions';

type Auth = { permissions: ReadonlySet<string> } | null;

const milliOrNull = (value: string | null): string | null =>
  value === null ? null : quantityFromDb(value).toString();

/** The default (Standard) price level: every item's one sale price lives there (decision 0032). */
async function standardLevelId(db: Kysely<DB>): Promise<bigint> {
  const row = await db
    .selectFrom('md.price_levels')
    .select('id')
    .where('is_default', '=', true)
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The items list: search by name in either language (Arabic letter variants ignored), code or barcode. */
/** Per-item stock over all warehouses: sellable and defective quantities, and the sellable value. */
const stockTotals = (db: Kysely<DB>) =>
  db
    .selectFrom('inv.balances')
    .select([
      'item_id',
      sql<string>`sum(quantity) FILTER (WHERE stock_status = 'available')`.as('on_hand'),
      sql<string>`sum(quantity) FILTER (WHERE stock_status = 'defective')`.as('defective'),
      sql<string>`sum(value_4dp) FILTER (WHERE stock_status = 'available')`.as('value_4dp'),
      sql<string>`max(avg_unit_cost_4dp) FILTER (WHERE stock_status = 'available')`.as('last_avg'),
    ])
    .groupBy('item_id');

export async function listItems(
  db: Kysely<DB>,
  query: ItemsQuery,
  showCost = false,
): Promise<ItemsResponse> {
  let base = db
    .selectFrom('md.items as i')
    .leftJoin(stockTotals(db).as('s'), 's.item_id', 'i.id')
    .leftJoin('md.price_levels as l', (join) => join.on('l.is_default', '=', true))
    .leftJoin('md.item_prices as p', (join) =>
      join.onRef('p.item_id', '=', 'i.id').onRef('p.price_level_id', '=', 'l.id'),
    )
    .leftJoin('md.item_barcodes as b', (join) =>
      join.onRef('b.item_id', '=', 'i.id').on('b.is_primary', '=', true),
    );
  if (query.status !== 'all') base = base.where('i.is_active', '=', query.status === 'active');
  if (query.itemType) base = base.where('i.item_type', '=', query.itemType);
  if (query.toReorder) {
    base = base
      .where('i.item_type', '=', 'stock')
      .where('i.reorder_level', 'is not', null)
      .where(sql<boolean>`coalesce(s.on_hand, 0) <= i.reorder_level`);
  }
  if (query.categoryId) {
    const root = BigInt(query.categoryId);
    base = base.where(
      'i.category_id',
      'in',
      sql<bigint>`(WITH RECURSIVE tree AS (
          SELECT id FROM md.item_categories WHERE id = ${root}
          UNION ALL SELECT c.id FROM md.item_categories c JOIN tree ON c.parent_id = tree.id)
        SELECT id FROM tree)`,
    );
  }
  if (query.q) {
    const q = query.q;
    base = base.where((eb) =>
      eb.or([
        sql<boolean>`i.search_key LIKE '%' || sys.normalize_search(${q}) || '%'`,
        eb(
          'i.id',
          'in',
          eb
            .selectFrom('md.item_barcodes')
            .select('item_id')
            .where('is_active', '=', true)
            .where(sql<string>`upper(barcode)`, '=', q.toUpperCase()),
        ),
      ]),
    );
  }
  const total = await base
    .select((eb) => eb.fn.countAll<bigint>().as('n'))
    .executeTakeFirstOrThrow();
  // A scanned barcode or a full code names one item exactly: it opens straight away.
  const exact = query.q
    ? await base
        .select('i.id')
        .where((eb) =>
          eb.or([
            eb(sql<string>`upper(i.code)`, '=', query.q!.toUpperCase()),
            eb(
              'i.id',
              'in',
              eb
                .selectFrom('md.item_barcodes')
                .select('item_id')
                .where('is_active', '=', true)
                .where(sql<string>`upper(barcode)`, '=', query.q!.toUpperCase()),
            ),
          ]),
        )
        .orderBy('i.code')
        .executeTakeFirst()
    : undefined;
  const exactId = exact?.id ?? null;
  const rows = await base
    .select([
      'i.id',
      'i.code',
      'i.item_type',
      'i.name_ar',
      'i.name_en',
      'i.category_id',
      'i.unit_id',
      'i.vat_category_id',
      'i.is_sellable',
      'i.is_active',
      'p.price_4dp',
      'p.includes_vat',
      'b.barcode',
      'i.reorder_level',
      's.on_hand',
      's.defective',
      's.value_4dp',
      's.last_avg',
    ])
    .$if(exactId !== null, (qb) => qb.orderBy(sql`i.id = ${exactId}`, 'desc'))
    .orderBy('i.code')
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .execute();
  const counts = await db
    .selectFrom('md.items')
    .select([
      sql<number>`count(*)::int`.as('active'),
      sql<number>`count(*) FILTER (WHERE item_type = 'stock')::int`.as('stock'),
      sql<number>`count(*) FILTER (WHERE item_type = 'service')::int`.as('service'),
      sql<number>`count(*) FILTER (WHERE item_type = 'bundle')::int`.as('bundle'),
    ])
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();
  return {
    total: Number(total.n),
    counts,
    exactMatchId: exactId?.toString() ?? null,
    items: rows.map((r): ItemListItem => ({
      id: r.id.toString(),
      code: r.code,
      itemType: r.item_type as ItemType,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      categoryId: r.category_id.toString(),
      unitId: r.unit_id.toString(),
      vatCategoryId: r.vat_category_id.toString(),
      price:
        r.price_4dp !== null && r.includes_vat !== null
          ? { price4dp: r.price_4dp.toString(), includesVat: r.includes_vat }
          : null,
      primaryBarcode: r.barcode,
      isSellable: r.is_sellable,
      isActive: r.is_active,
      ...(r.item_type === 'stock' ? { stock: stockFigures(r, showCost) } : {}),
    })),
  };
}

/** Only someone with `items.cost` (the owner) is told purchase prices (decision 0038). */
export const canSeeCost = (auth: Auth): boolean => auth?.permissions.has('items.cost') ?? false;

/**
 * The cost shown for an item: its own purchase price; for a kit the sum of its components'
 * (quantity × price, rounded once per component with the shared helper), or null while any
 * component has none.
 */
function purchaseCostOf(
  item: { item_type: string; fallback_unit_cost_4dp: bigint | null },
  components: { fallback_unit_cost_4dp: bigint | null; quantity: string }[],
): string | null {
  if (item.item_type !== 'bundle') return item.fallback_unit_cost_4dp?.toString() ?? null;
  let total = 0n;
  for (const c of components) {
    if (c.fallback_unit_cost_4dp === null) return null;
    total += roundDiv(c.fallback_unit_cost_4dp * quantityFromDb(c.quantity), 1000n);
  }
  return components.length === 0 ? null : total.toString();
}

function stockFigures(
  r: {
    reorder_level: string | null;
    on_hand: string | null;
    defective: string | null;
    value_4dp: string | null;
    last_avg: string | null;
  },
  showCost: boolean,
): ItemStockFigures {
  const onHand = r.on_hand === null ? 0n : quantityFromDb(r.on_hand);
  const reorder = r.reorder_level === null ? null : quantityFromDb(r.reorder_level);
  // The average over all warehouses; with nothing on hand, the last known average.
  const avg =
    onHand > 0n && r.value_4dp !== null
      ? roundDiv(BigInt(r.value_4dp) * 1000n, onHand).toString()
      : r.last_avg;
  return {
    onHandMilli: onHand.toString(),
    defectiveMilli: (r.defective === null ? 0n : quantityFromDb(r.defective)).toString(),
    reorderLevelMilli: reorder?.toString() ?? null,
    toReorder: reorder !== null && onHand <= reorder,
    ...(showCost ? { avgUnitCost4dp: avg } : {}),
  };
}

export async function getItem(db: Kysely<DB>, id: bigint, showCost = false): Promise<ItemDetail> {
  const item = await db
    .selectFrom('md.items')
    .selectAll()
    .select(sql<string | null>`md.item_in_use(id)`.as('in_use'))
    .where('id', '=', id)
    .executeTakeFirst();
  if (!item) throw new AppError('NOT_FOUND', 'No such item');
  const price = await db
    .selectFrom('md.item_prices')
    .select(['price_4dp', 'includes_vat'])
    .where('item_id', '=', id)
    .where('price_level_id', '=', await standardLevelId(db))
    .executeTakeFirst();
  const barcodes = await db
    .selectFrom('md.item_barcodes')
    .select(['id', 'barcode', 'qty_per_scan', 'is_primary'])
    .where('item_id', '=', id)
    .where('is_active', '=', true)
    .orderBy('is_primary', 'desc')
    .orderBy('id')
    .execute();
  const components = await db
    .selectFrom('md.bundle_components as c')
    .innerJoin('md.items as i', 'i.id', 'c.component_item_id')
    .select([
      'i.id',
      'i.code',
      'i.name_ar',
      'i.name_en',
      'i.unit_id',
      'i.fallback_unit_cost_4dp',
      'c.quantity',
    ])
    .where('c.bundle_item_id', '=', id)
    .orderBy('i.code')
    .execute();
  const primary = barcodes.find((b) => b.is_primary);
  return {
    ...(showCost ? { purchaseCost4dp: purchaseCostOf(item, components) } : {}),
    id: item.id.toString(),
    code: item.code,
    itemType: item.item_type as ItemType,
    nameAr: item.name_ar,
    nameEn: item.name_en,
    descriptionAr: item.description_ar,
    descriptionEn: item.description_en,
    categoryId: item.category_id.toString(),
    unitId: item.unit_id.toString(),
    vatCategoryId: item.vat_category_id.toString(),
    defaultBusinessLineId: item.default_business_line_id?.toString() ?? null,
    reorderLevelMilli: milliOrNull(item.reorder_level),
    reorderQtyMilli: milliOrNull(item.reorder_qty),
    price: price ? { price4dp: price.price_4dp.toString(), includesVat: price.includes_vat } : null,
    primaryBarcode: primary?.barcode ?? null,
    barcodes: barcodes.map((b): BarcodeItem => ({
      id: b.id.toString(),
      barcode: b.barcode,
      qtyPerScanMilli: quantityFromDb(b.qty_per_scan).toString(),
      isPrimary: b.is_primary,
    })),
    components: components.map((c): ComponentItem => ({
      itemId: c.id.toString(),
      code: c.code,
      nameAr: c.name_ar,
      nameEn: c.name_en,
      unitId: c.unit_id.toString(),
      quantityMilli: quantityFromDb(c.quantity).toString(),
    })),
    isSellable: item.is_sellable,
    isActive: item.is_active,
    inUse: item.in_use,
    rowVersion: item.row_version,
  };
}

/** The next free code in the category, e.g. CHEM-0013 (decision 0037: suggested, then fixed). */
export async function suggestItemCode(db: Kysely<DB>, categoryId: bigint): Promise<string> {
  const category = await db
    .selectFrom('md.item_categories')
    .select('code')
    .where('id', '=', categoryId)
    .executeTakeFirst();
  if (!category) throw new AppError('NOT_FOUND', 'No such category');
  const prefix = normalizeCode(category.code);
  const codes = await db
    .selectFrom('md.items')
    .select('code')
    .where(sql<string>`upper(code)`, 'like', `${prefix.replace(/[%_\\]/g, '\\$&')}-%`)
    .execute();
  return nextCode(
    prefix,
    codes.map((c) => c.code),
  );
}

// ---------------------------------------------------------------------------------------------
// Saving: the item, its price, its barcodes and its kit components, in one transaction
// ---------------------------------------------------------------------------------------------

type ItemInput = Omit<CreateItemRequest, 'code'>;

/** Checks that cannot be expressed in the request schema; the database checks the rest again. */
async function checkInput(db: Kysely<DB>, body: ItemInput): Promise<void> {
  const stock = body.itemType === 'stock';
  if (!stock && (body.reorderLevelMilli !== null || body.reorderQtyMilli !== null)) {
    throw fieldError('reorderLevelMilli', 'stock_only');
  }
  if (body.reorderQtyMilli === '0') throw fieldError('reorderQtyMilli', 'too_small');
  if (
    body.itemType === 'bundle' &&
    body.purchaseCost4dp !== undefined &&
    body.purchaseCost4dp !== null
  )
    throw fieldError('purchaseCost4dp', 'kit_cost');
  if (body.itemType === 'bundle' && body.components.length === 0) {
    throw fieldError('components', 'required');
  }
  if (body.itemType !== 'bundle' && body.components.length > 0) {
    throw fieldError('components', 'kits_only');
  }
  if (new Set(body.components.map((c) => c.itemId)).size !== body.components.length) {
    throw fieldError('components', 'duplicate');
  }
  if (body.components.some((c) => c.quantityMilli === '0')) {
    throw fieldError('components', 'too_small');
  }
  const barcodes = body.barcodes.map((b) => b.barcode.toUpperCase());
  if (new Set(barcodes).size !== barcodes.length) throw fieldError('barcodes', 'duplicate');
  if (body.barcodes.filter((b) => b.isPrimary).length > 1) {
    throw fieldError('barcodes', 'one_primary');
  }
  if (body.barcodes.some((b) => b.qtyPerScanMilli === '0')) {
    throw fieldError('barcodes', 'too_small');
  }
  if (body.isSellable && (!body.price || body.price.price4dp === '0')) {
    throw ruleError('PRICE_REQUIRED', 'An item for sale needs a sale price above zero');
  }
  const unit = await db
    .selectFrom('md.units')
    .select('decimals')
    .where('id', '=', BigInt(body.unitId))
    .executeTakeFirst();
  if (!unit) throw fieldError('unitId', 'unknown');
  for (const field of ['reorderLevelMilli', 'reorderQtyMilli'] as const) {
    const value = body[field];
    if (value !== null && !fitsUnitDecimals(BigInt(value), unit.decimals)) {
      throw ruleError('QUANTITY_DECIMALS', `${field} has too many decimals`, { field });
    }
  }
}

function itemValues(body: ItemInput) {
  return {
    item_type: body.itemType,
    name_ar: body.nameAr,
    name_en: body.nameEn,
    description_ar: body.descriptionAr ?? null,
    description_en: body.descriptionEn ?? null,
    category_id: BigInt(body.categoryId),
    unit_id: BigInt(body.unitId),
    vat_category_id: BigInt(body.vatCategoryId),
    default_business_line_id: body.defaultBusinessLineId
      ? BigInt(body.defaultBusinessLineId)
      : null,
    reorder_level:
      body.reorderLevelMilli === null ? null : quantityToDb(BigInt(body.reorderLevelMilli)),
    reorder_qty: body.reorderQtyMilli === null ? null : quantityToDb(BigInt(body.reorderQtyMilli)),
    is_sellable: body.isSellable,
    // Left out = unchanged (someone without `items.cost` never sends it); the database checks the
    // permission whenever the value really changes.
    ...(body.purchaseCost4dp === undefined
      ? {}
      : {
          fallback_unit_cost_4dp:
            body.purchaseCost4dp === null ? null : BigInt(body.purchaseCost4dp),
        }),
  };
}

/** The one sale price: a change needs `prices.manage` as well; a price is never deleted. */
async function savePrice(
  trx: Transaction<DB>,
  auth: Auth,
  itemId: bigint,
  price: ItemInput['price'],
): Promise<void> {
  if (!price) return;
  const levelId = await standardLevelId(trx);
  const current = await trx
    .selectFrom('md.item_prices')
    .select(['price_4dp', 'includes_vat'])
    .where('item_id', '=', itemId)
    .where('price_level_id', '=', levelId)
    .executeTakeFirst();
  const value = BigInt(price.price4dp);
  if (current && current.price_4dp === value && current.includes_vat === price.includesVat) return;
  requireAlso(auth, 'prices.manage');
  if (current) {
    await trx
      .updateTable('md.item_prices')
      .set({ price_4dp: value, includes_vat: price.includesVat })
      .where('item_id', '=', itemId)
      .where('price_level_id', '=', levelId)
      .execute();
  } else {
    await trx
      .insertInto('md.item_prices')
      .values(
        stamped('md.item_prices', {
          item_id: itemId,
          price_level_id: levelId,
          price_4dp: value,
          includes_vat: price.includesVat,
        }),
      )
      .execute();
  }
}

/** Keeps the listed barcodes, deactivates the others, adds new ones; exactly one primary. */
async function saveBarcodes(
  trx: Transaction<DB>,
  itemId: bigint,
  wanted: ItemInput['barcodes'],
): Promise<void> {
  const list = wanted.map((b, i) => ({
    barcode: b.barcode,
    qty: quantityToDb(BigInt(b.qtyPerScanMilli)),
    primary: b.isPrimary || (i === 0 && !wanted.some((w) => w.isPrimary)),
  }));
  const existing = await trx
    .selectFrom('md.item_barcodes')
    .select(['id', 'barcode', 'qty_per_scan', 'is_primary'])
    .where('item_id', '=', itemId)
    .where('is_active', '=', true)
    .execute();
  const key = (barcode: string) => barcode.toUpperCase();
  const wantedKeys = new Set(list.map((b) => key(b.barcode)));
  // Clear the primary mark first, so the new primary never meets the old one.
  await trx
    .updateTable('md.item_barcodes')
    .set({ is_primary: false })
    .where('item_id', '=', itemId)
    .where('is_primary', '=', true)
    .execute();
  for (const old of existing) {
    if (!wantedKeys.has(key(old.barcode))) {
      await trx
        .updateTable('md.item_barcodes')
        .set({ is_active: false })
        .where('id', '=', old.id)
        .execute();
    }
  }
  for (const b of list) {
    const old = existing.find((e) => key(e.barcode) === key(b.barcode));
    if (old) {
      await trx
        .updateTable('md.item_barcodes')
        .set({ qty_per_scan: b.qty, is_primary: b.primary })
        .where('id', '=', old.id)
        .execute();
    } else {
      await trx
        .insertInto('md.item_barcodes')
        .values(
          stamped('md.item_barcodes', {
            item_id: itemId,
            barcode: b.barcode,
            qty_per_scan: b.qty,
            is_primary: b.primary,
          }),
        )
        .execute();
    }
  }
}

/** A kit's components: removed ones are deleted (link table, audited), others updated or added. */
async function saveComponents(
  trx: Transaction<DB>,
  kitId: bigint,
  wanted: ItemInput['components'],
): Promise<void> {
  const existing = await trx
    .selectFrom('md.bundle_components')
    .select(['component_item_id', 'quantity'])
    .where('bundle_item_id', '=', kitId)
    .execute();
  for (const old of existing) {
    if (!wanted.some((w) => BigInt(w.itemId) === old.component_item_id)) {
      await trx
        .deleteFrom('md.bundle_components')
        .where('bundle_item_id', '=', kitId)
        .where('component_item_id', '=', old.component_item_id)
        .execute();
    }
  }
  for (const w of wanted) {
    const componentId = BigInt(w.itemId);
    const quantity = quantityToDb(BigInt(w.quantityMilli));
    const old = existing.find((e) => e.component_item_id === componentId);
    if (!old) {
      await trx
        .insertInto('md.bundle_components')
        .values(
          stamped('md.bundle_components', {
            bundle_item_id: kitId,
            component_item_id: componentId,
            quantity,
          }),
        )
        .execute();
    } else if (quantityFromDb(old.quantity) !== BigInt(w.quantityMilli)) {
      await trx
        .updateTable('md.bundle_components')
        .set({ quantity })
        .where('bundle_item_id', '=', kitId)
        .where('component_item_id', '=', componentId)
        .execute();
    }
  }
}

export async function createItem(
  trx: Transaction<DB>,
  auth: Auth,
  body: CreateItemRequest,
): Promise<ItemDetail> {
  await checkInput(trx, body);
  const row = await trx
    .insertInto('md.items')
    .values(stamped('md.items', { code: normalizeCode(body.code), ...itemValues(body) }))
    .returning('id')
    .executeTakeFirstOrThrow();
  await savePrice(trx, auth, row.id, body.price);
  await saveBarcodes(trx, row.id, body.barcodes);
  await saveComponents(trx, row.id, body.components);
  return getItem(trx, row.id, canSeeCost(auth));
}

export async function updateItem(
  trx: Transaction<DB>,
  auth: Auth,
  id: bigint,
  body: UpdateItemRequest,
): Promise<ItemDetail> {
  await checkInput(trx, body);
  // Always updates the item row, so its version moves with any change to price, barcodes or kit.
  const result = await trx
    .updateTable('md.items')
    .set(itemValues(body))
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.items', id, result);
  await savePrice(trx, auth, id, body.price);
  await saveBarcodes(trx, id, body.barcodes);
  await saveComponents(trx, id, body.components);
  return getItem(trx, id, canSeeCost(auth));
}

export async function setItemActive(
  trx: Transaction<DB>,
  id: bigint,
  active: boolean,
  rowVersion: number,
  auth: Auth,
): Promise<ItemDetail> {
  const result = await trx
    .updateTable('md.items')
    .set({ is_active: active })
    .where('id', '=', id)
    .where('row_version', '=', rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.items', id, result);
  return getItem(trx, id, canSeeCost(auth));
}
