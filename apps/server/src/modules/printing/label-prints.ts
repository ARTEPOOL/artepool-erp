/**
 * Label prints (decision 0099): what a label needs to know about items, the record of every label
 * print (with the price on the label), and the "price changed, label is old" list: active items
 * whose last printed label shows another price than today (price, "price includes VAT", the item's
 * VAT category or its rate). A print whose price changed meanwhile is not recorded (the database
 * refuses it too).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { quantityFromDb, unitPriceBreakdown } from '@artepool/shared';
import type {
  LabelItem,
  PriceChangedItem,
  RecordLabelPrintsRequest,
  RecordLabelPrintsResponse,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { filledByDatabase } from '../../platform/db/stamped';
import { AppError } from '../../platform/errors/app-error';

type Db = Kysely<DB> | Transaction<DB>;

/** Items with everything a label shows, their VAT rate today and their quantity on hand. */
const labelItemRows = (db: Db) =>
  db
    .selectFrom('md.items as i')
    .innerJoin('md.vat_categories as v', 'v.id', 'i.vat_category_id')
    .innerJoin('md.units as u', 'u.id', 'i.unit_id')
    .leftJoin('md.price_levels as l', (join) => join.on('l.is_default', '=', true))
    .leftJoin('md.item_prices as p', (join) =>
      join.onRef('p.item_id', '=', 'i.id').onRef('p.price_level_id', '=', 'l.id'),
    )
    .leftJoin('md.item_barcodes as b', (join) =>
      join
        .onRef('b.item_id', '=', 'i.id')
        .on('b.is_primary', '=', true)
        .on('b.is_active', '=', true),
    )
    .select([
      'i.id',
      'i.code',
      'i.name_ar',
      'i.name_en',
      'i.item_type',
      'i.pack_ar',
      'i.pack_en',
      'i.unit_id',
      'i.category_id',
      'i.is_active',
      'u.decimals',
      'v.rate_bp',
      'p.price_4dp',
      'p.includes_vat',
      'b.barcode',
      sql<string | null>`(SELECT sum(s.quantity) FROM inv.balances s
         WHERE s.item_id = i.id AND s.stock_status = 'available')`.as('on_hand'),
    ]);

type LabelItemRow = Awaited<ReturnType<ReturnType<typeof labelItemRows>['execute']>>[number];

function toLabelItem(r: LabelItemRow): LabelItem {
  return {
    id: r.id.toString(),
    code: r.code,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    primaryBarcode: r.barcode,
    price:
      r.price_4dp !== null && r.includes_vat !== null
        ? { price4dp: r.price_4dp.toString(), includesVat: r.includes_vat }
        : null,
    rateBp: r.rate_bp,
    packAr: r.pack_ar,
    packEn: r.pack_en,
    unitId: r.unit_id.toString(),
    unitDecimals: r.decimals,
    categoryId: r.category_id.toString(),
    isActive: r.is_active,
    onHandMilli:
      r.item_type === 'stock'
        ? (r.on_hand === null ? 0n : quantityFromDb(r.on_hand)).toString()
        : null,
  };
}

const grossOf = (price4dp: bigint, includesVat: boolean, rateBp: number) =>
  unitPriceBreakdown(price4dp, includesVat, BigInt(rateBp)).grossFils;

export async function labelItems(db: Db, ids: string[]): Promise<LabelItem[]> {
  const rows = await labelItemRows(db)
    .where(
      'i.id',
      'in',
      ids.map((id) => BigInt(id)),
    )
    .orderBy('i.code')
    .execute();
  return rows.map(toLabelItem);
}

/** Active items whose last printed label shows another price than today, by code. */
export async function priceChanged(db: Db, categoryId?: string): Promise<PriceChangedItem[]> {
  const last = db
    .selectFrom('inv.label_prints')
    .distinctOn('item_id')
    .select(['item_id', 'price_4dp', 'includes_vat', 'vat_rate_bp', 'gross_fils', 'created_at'])
    .orderBy('item_id')
    .orderBy('id', 'desc');
  let query = labelItemRows(db)
    .innerJoin(last.as('lp'), 'lp.item_id', 'i.id')
    .select([
      'lp.price_4dp as printed_price',
      'lp.includes_vat as printed_includes',
      'lp.vat_rate_bp as printed_rate',
      'lp.gross_fils as printed_gross',
      'lp.created_at as printed_at',
    ])
    .where('i.is_active', '=', true)
    // A last label without a price has nothing to go out of date.
    .where('lp.price_4dp', 'is not', null)
    .where((eb) =>
      eb.or([
        eb(sql`p.price_4dp`, 'is distinct from', sql`lp.price_4dp`),
        eb(sql`p.includes_vat`, 'is distinct from', sql`lp.includes_vat`),
        eb(sql`v.rate_bp`, 'is distinct from', sql`lp.vat_rate_bp`),
      ]),
    );
  if (categoryId) {
    const root = BigInt(categoryId);
    query = query.where(
      'i.category_id',
      'in',
      sql<bigint>`(WITH RECURSIVE tree AS (
          SELECT id FROM md.item_categories WHERE id = ${root}
          UNION ALL SELECT c.id FROM md.item_categories c JOIN tree ON c.parent_id = tree.id)
        SELECT id FROM tree)`,
    );
  }
  const rows = await query.orderBy('i.code').execute();
  return rows.map((r) => {
    const item = toLabelItem(r);
    return {
      ...item,
      printed: {
        price4dp: r.printed_price!.toString(),
        includesVat: r.printed_includes!,
        rateBp: r.printed_rate!,
        grossFils: r.printed_gross!.toString(),
        printedAt: r.printed_at.toISOString(),
      },
      nowGrossFils: item.price
        ? grossOf(BigInt(item.price.price4dp), item.price.includesVat, item.rateBp).toString()
        : null,
    };
  });
}

/**
 * Records the labels just printed, one row per item, with the price on the label. An item whose
 * price is not the printed one any more (it changed while printing) is left out and reported.
 */
export async function recordLabelPrints(
  trx: Transaction<DB>,
  body: RecordLabelPrintsRequest,
): Promise<RecordLabelPrintsResponse> {
  const version = await trx
    .selectFrom('sys.print_template_versions as v')
    .innerJoin('sys.print_templates as t', 't.id', 'v.template_id')
    .select('v.id')
    .where('v.id', '=', BigInt(body.designVersionId))
    .where('t.doc_kind', '=', 'barcode_label')
    .executeTakeFirst();
  if (!version) throw new AppError('VALIDATION_FAILED', 'Not a label design version');
  const size = await trx
    .selectFrom('md.label_sizes')
    .select('id')
    .where('id', '=', BigInt(body.sizeId))
    .executeTakeFirst();
  if (!size) throw new AppError('VALIDATION_FAILED', 'No such label size');

  const ids = body.lines.map((l) => BigInt(l.itemId));
  // The prices now. A price saved at the same moment leaves the item on the "price changed" list.
  const items = await trx
    .selectFrom('md.items as i')
    .innerJoin('md.vat_categories as v', 'v.id', 'i.vat_category_id')
    .select(['i.id', 'v.rate_bp'])
    .where('i.id', 'in', ids)
    .execute();
  if (items.length !== ids.length) throw new AppError('NOT_FOUND', 'No such item');
  const prices = await trx
    .selectFrom('md.item_prices as p')
    .innerJoin('md.price_levels as l', 'l.id', 'p.price_level_id')
    .select(['p.item_id', 'p.price_4dp', 'p.includes_vat'])
    .where('l.is_default', '=', true)
    .where('p.item_id', 'in', ids)
    .execute();
  const rate = new Map(items.map((i) => [i.id.toString(), i.rate_bp]));
  const price = new Map(prices.map((p) => [p.item_id.toString(), p]));

  const recorded: string[] = [];
  const changed: string[] = [];
  for (const line of body.lines) {
    if (line.price) {
      const now = price.get(line.itemId);
      const same =
        now !== undefined &&
        now.price_4dp.toString() === line.price.price4dp &&
        now.includes_vat === line.price.includesVat &&
        rate.get(line.itemId) === line.price.rateBp;
      if (!same) {
        changed.push(line.itemId);
        continue;
      }
    }
    await trx
      .insertInto('inv.label_prints')
      .values(
        filledByDatabase('inv.label_prints', {
          item_id: BigInt(line.itemId),
          label_size_id: size.id,
          design_version_id: version.id,
          copies: line.copies,
          source: body.source,
          price_4dp: line.price ? BigInt(line.price.price4dp) : null,
          includes_vat: line.price?.includesVat ?? null,
          vat_rate_bp: line.price?.rateBp ?? null,
          gross_fils: line.price
            ? grossOf(BigInt(line.price.price4dp), line.price.includesVat, line.price.rateBp)
            : null,
        }),
      )
      .execute();
    recorded.push(line.itemId);
  }
  return { recorded, priceChanged: changed };
}
