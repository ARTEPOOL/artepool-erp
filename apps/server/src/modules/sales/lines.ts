/**
 * Turns the lines a screen sends into rows for quotation or document lines: the item's price
 * (unless another one is typed), a percentage discount turned into fils, and the document
 * discount spread across the lines before VAT with the largest-remainder helper (decision 0012).
 * The database then works out net, VAT and gross per line with the same shared formulas.
 */
import type { Kysely, Transaction } from 'kysely';
import { allocateDocumentDiscount, lineAmountFils, roundDiv } from '@artepool/shared';
import type { SalesLineInput } from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { fieldError } from '../../platform/db/versioned';

type Db = Kysely<DB> | Transaction<DB>;

export interface PreparedLine {
  line_no: number;
  item_id: bigint;
  description_ar: string;
  description_en: string;
  unit_id: bigint;
  business_line_id: bigint;
  quantity: string;
  unit_price_4dp: bigint;
  line_discount_bp: number | null;
  line_discount_fils: bigint;
  doc_discount_alloc_fils: bigint;
  is_optional: boolean;
  note: string | null;
  quotation_line_id?: bigint | null;
}

/** Thousandths → the numeric text the database stores ("2500" → "2.500"). */
export const milliToDb = (milli: bigint): string => {
  const sign = milli < 0n ? '-' : '';
  const abs = milli < 0n ? -milli : milli;
  return `${sign}${abs / 1000n}.${(abs % 1000n).toString().padStart(3, '0')}`;
};

export async function prepareLines(
  db: Db,
  input: {
    lines: SalesLineInput[];
    /** Sales documents made from a quotation: its lines keep their agreed prices (0049). */
    quotationId?: bigint | null;
    docDiscountFils: bigint;
    businessLineId: bigint;
    priceLevelId: bigint | null;
    /** Sales documents refuse items that are not for sale; quotations too. */
  },
): Promise<PreparedLine[]> {
  const ids = [...new Set(input.lines.map((l) => BigInt(l.itemId)))];
  const items = await db
    .selectFrom('md.items as i')
    .innerJoin('md.units as u', 'u.id', 'i.unit_id')
    .leftJoin('md.price_levels as pl', (join) =>
      input.priceLevelId === null
        ? join.on('pl.is_default', '=', true)
        : join.on('pl.id', '=', input.priceLevelId),
    )
    .leftJoin('md.item_prices as p', (join) =>
      join.onRef('p.item_id', '=', 'i.id').onRef('p.price_level_id', '=', 'pl.id'),
    )
    .select([
      'i.id',
      'i.name_ar',
      'i.name_en',
      'i.unit_id',
      'i.default_business_line_id',
      'i.is_active',
      'i.is_sellable',
      'u.decimals',
      'p.price_4dp',
    ])
    .where('i.id', 'in', ids.length > 0 ? ids : [0n])
    .execute();
  const byId = new Map(items.map((i) => [i.id.toString(), i]));
  // Lines of the document's quotation: an untouched price stays the agreed one, not today's.
  const quotationLineIds = input.lines.flatMap((l) =>
    l.quotationLineId ? [BigInt(l.quotationLineId)] : [],
  );
  const agreed = new Map(
    quotationLineIds.length > 0 && input.quotationId
      ? (
          await db
            .selectFrom('sales.quotation_lines')
            .select(['id', 'unit_price_4dp'])
            .where('quotation_id', '=', input.quotationId)
            .where('id', 'in', quotationLineIds)
            .execute()
        ).map((q) => [q.id.toString(), q.unit_price_4dp])
      : [],
  );

  const rows = input.lines.map((l, index) => {
    const item = byId.get(l.itemId);
    if (!item || !item.is_active || !item.is_sellable) {
      throw fieldError(`lines.${index}.itemId`, 'not_for_sale');
    }
    const quantity = BigInt(l.quantityMilli);
    // A quantity must fit the unit: pieces are whole, kilograms take 3 decimals.
    if (quantity % 10n ** BigInt(3 - Math.min(3, item.decimals)) !== 0n) {
      throw fieldError(`lines.${index}.quantityMilli`, 'unit_decimals');
    }
    if (l.quotationLineId && !agreed.has(l.quotationLineId)) {
      throw fieldError(`lines.${index}.quotationLineId`, 'invalid');
    }
    const unitPrice =
      l.unitPrice4dp !== undefined
        ? BigInt(l.unitPrice4dp)
        : l.quotationLineId
          ? agreed.get(l.quotationLineId)!
          : (item.price_4dp ?? 0n);
    const amount = lineAmountFils(quantity, unitPrice);
    const lineDiscount =
      l.lineDiscountBp !== undefined
        ? roundDiv(amount * BigInt(l.lineDiscountBp), 10_000n)
        : BigInt(l.lineDiscountFils ?? '0');
    if (lineDiscount > amount) throw fieldError(`lines.${index}.lineDiscountFils`, 'too_large');
    return {
      line_no: index + 1,
      item_id: item.id,
      description_ar: l.descriptionAr ?? item.name_ar,
      description_en: l.descriptionEn ?? item.name_en,
      unit_id: item.unit_id,
      business_line_id: l.businessLineId
        ? BigInt(l.businessLineId)
        : (item.default_business_line_id ?? input.businessLineId),
      quantity: milliToDb(quantity),
      unit_price_4dp: unitPrice,
      line_discount_bp: l.lineDiscountBp ?? null,
      line_discount_fils: lineDiscount,
      doc_discount_alloc_fils: 0n,
      is_optional: l.isOptional ?? false,
      note: l.note ?? null,
      quotation_line_id: l.quotationLineId ? BigInt(l.quotationLineId) : null,
      weight: l.isOptional ? 0n : amount - lineDiscount,
    };
  });

  // The document discount goes on the counted lines in proportion to what they are worth.
  if (input.docDiscountFils > 0n) {
    const weights = rows.map((r) => r.weight);
    if (input.docDiscountFils > weights.reduce((s, w) => s + w, 0n)) {
      throw fieldError('docDiscountFils', 'too_large');
    }
    allocateDocumentDiscount(input.docDiscountFils, weights).forEach((share, i) => {
      rows[i]!.doc_discount_alloc_fils = share;
    });
  }
  return rows.map(({ weight: _weight, ...row }) => row);
}
