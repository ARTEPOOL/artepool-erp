/**
 * Settings → VAT & numbering: the four fixed VAT categories (decision 0033; only the owner
 * changes a rate, with a reason, for new documents only) and the gapless numbering series
 * (decision 0011; prefix, width and start can change until the first number is used).
 */
import type { Kysely, Transaction } from 'kysely';
import type {
  SeriesItem,
  UpdateSeriesRequest,
  UpdateVatRateRequest,
  VatCategoryItem,
  VatCode,
  VatResponse,
} from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { expectUpdated } from '../../platform/db/versioned';
import { AppError } from '../../platform/errors/app-error';

export async function listVat(db: Kysely<DB>): Promise<VatResponse> {
  const rows = await db.selectFrom('md.vat_categories').selectAll().orderBy('id').execute();
  const setting = await db
    .selectFrom('sys.settings')
    .select('value')
    .where('key', '=', 'einvoice.mandatory_from')
    .executeTakeFirst();
  const from = setting?.value;
  return {
    categories: rows.map((r): VatCategoryItem => ({
      id: r.id.toString(),
      code: r.code as VatCode,
      nameAr: r.name_ar,
      nameEn: r.name_en,
      rateBp: r.rate_bp,
      rowVersion: r.row_version,
    })),
    einvoiceMandatoryFrom: typeof from === 'string' ? from : null,
  };
}

export async function updateVatRate(
  trx: Transaction<DB>,
  id: bigint,
  body: UpdateVatRateRequest,
): Promise<VatCategoryItem> {
  const result = await trx
    .updateTable('md.vat_categories')
    .set({ rate_bp: body.rateBp })
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'md.vat_categories', id, result);
  const category = (await listVat(trx)).categories.find((c) => c.id === id.toString());
  if (!category) throw new AppError('NOT_FOUND', 'No such VAT category');
  return category;
}

function formatNumber(prefix: string, width: number, value: bigint): string {
  return `${prefix}${value.toString().padStart(width, '0')}`;
}

export async function listSeries(db: Kysely<DB>): Promise<SeriesItem[]> {
  const rows = await db.selectFrom('sys.document_series').selectAll().orderBy('id').execute();
  return rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    docType: r.doc_type,
    channel: r.channel as 'pos' | 'office' | null,
    prefix: r.prefix,
    numberWidth: r.number_width,
    startNumber: r.start_number.toString(),
    nextNumber: r.next_number.toString(),
    used: r.next_number !== r.start_number,
    nextFormatted: formatNumber(r.prefix, r.number_width, r.next_number),
    isActive: r.is_active,
    rowVersion: r.row_version,
  }));
}

export async function updateSeries(
  trx: Transaction<DB>,
  id: bigint,
  body: UpdateSeriesRequest,
): Promise<SeriesItem> {
  const result = await trx
    .updateTable('sys.document_series')
    .set({
      prefix: body.prefix,
      number_width: body.numberWidth,
      start_number: BigInt(body.startNumber),
    })
    .where('id', '=', id)
    .where('row_version', '=', body.rowVersion)
    .executeTakeFirst();
  await expectUpdated(trx, 'sys.document_series', id, result);
  const series = (await listSeries(trx)).find((s) => s.id === id.toString());
  if (!series) throw new AppError('NOT_FOUND', 'No such series');
  return series;
}
