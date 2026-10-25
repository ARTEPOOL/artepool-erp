/**
 * Settings → VAT & numbering: the four fixed VAT categories (decision 0033; only the owner
 * changes a rate, with a reason, for new documents only) and the gapless numbering series
 * (decision 0011; prefix, width and start can change until the first number is used).
 */
import type { Kysely, Transaction } from 'kysely';
import type {
  ScreenLockSettings,
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

// ---------------------------------------------------------------------------------------------
// The idle screen lock (decision 0079): minutes per kind of PC, 0 = never. Owner only.
// ---------------------------------------------------------------------------------------------

const LOCK_KEYS = {
  officeMinutes: 'security.idle_lock_minutes.office',
  posMinutes: 'security.idle_lock_minutes.pos',
} as const;

export async function getScreenLock(db: Kysely<DB>): Promise<ScreenLockSettings> {
  const rows = await db
    .selectFrom('sys.settings')
    .select(['key', 'value'])
    .where('key', 'in', Object.values(LOCK_KEYS))
    .execute();
  const value = (key: string) => Number(rows.find((r) => r.key === key)?.value ?? 0);
  return { officeMinutes: value(LOCK_KEYS.officeMinutes), posMinutes: value(LOCK_KEYS.posMinutes) };
}

/** Saves both values; new sign-ins use them (the database checks the 0–240 range). */
export async function saveScreenLock(
  trx: Transaction<DB>,
  body: ScreenLockSettings,
): Promise<ScreenLockSettings> {
  for (const [field, key] of Object.entries(LOCK_KEYS) as [keyof ScreenLockSettings, string][]) {
    await trx
      .updateTable('sys.settings')
      .set({ value: JSON.stringify(body[field]) })
      .where('key', '=', key)
      .execute();
  }
  return getScreenLock(trx);
}
