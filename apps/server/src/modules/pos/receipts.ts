/**
 * What the thermal receipt prints (decisions 0008, 0062): the document as issued, with the seller
 * frozen on it at issue, its payments and change, the cashier, the shift and the PC. Printing is
 * counted on the document: the first print is the original, every later one is a copy and needs
 * documents.reprint.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { PosPaymentResult, ReceiptData } from '@artepool/shared/contracts';
import type { DB } from '../../platform/db/schema.generated';
import { AppError } from '../../platform/errors/app-error';
import { requireAlso } from '../../platform/permissions';
import { settingsOf } from '../printing/service';
import { countPrint, getDocument } from '../sales/documents';

type Db = Kysely<DB> | Transaction<DB>;

export async function receiptData(db: Db, documentId: bigint): Promise<ReceiptData> {
  const d = await db
    .selectFrom('sales.documents as d')
    .innerJoin('auth.devices as dev', 'dev.id', 'd.device_id')
    .leftJoin('auth.users as u', 'u.id', 'd.issued_by')
    .leftJoin('cash.shifts as s', 's.id', 'd.shift_id')
    .select([
      'd.status',
      'd.seller_snapshot',
      'd.print_count',
      'dev.code as device_code',
      'u.display_name_ar',
      'u.display_name_en',
      's.shift_number',
    ])
    .where('d.id', '=', documentId)
    .executeTakeFirst();
  if (!d || d.status !== 'issued') throw new AppError('NOT_FOUND', 'No such issued document');
  const seller = (d.seller_snapshot ?? {}) as Record<string, string | null>;
  const rows = await db
    .selectFrom('sales.payment_allocations as a')
    .innerJoin('sales.payments as p', 'p.id', 'a.payment_id')
    .innerJoin('md.payment_methods as m', 'm.id', 'p.payment_method_id')
    .select([
      'p.id',
      'p.doc_number',
      'm.name_ar',
      'm.name_en',
      'p.method_kind',
      'p.amount_fils',
      'p.tendered_fils',
      'p.change_fils',
      'p.reference',
    ])
    .where('a.document_id', '=', documentId)
    .orderBy('p.id')
    .execute();
  const payments: PosPaymentResult[] = rows.map((r) => ({
    id: r.id.toString(),
    docNumber: r.doc_number,
    methodNameAr: r.name_ar,
    methodNameEn: r.name_en,
    methodKind: r.method_kind as PosPaymentResult['methodKind'],
    amountFils: r.amount_fils.toString(),
    tenderedFils: r.tendered_fils?.toString() ?? null,
    changeFils: r.change_fils?.toString() ?? null,
    reference: r.reference,
  }));
  const markCopies = await db
    .selectFrom('sys.settings')
    .select(sql<boolean>`coalesce((value #>> '{}')::boolean, true)`.as('v'))
    .where('key', '=', 'print.mark_reprints_as_copy')
    .executeTakeFirst();
  return {
    seller: {
      nameAr: seller.trade_name_ar ?? seller.legal_name_ar ?? '',
      nameEn: seller.trade_name_en ?? seller.legal_name_en ?? '',
      addressAr: seller.address_ar ?? '',
      addressEn: seller.address_en ?? '',
      trn: seller.trn ?? null,
      phone: seller.phone ?? null,
      email: seller.email ?? null,
    },
    document: await getDocument(db, documentId),
    payments,
    changeFils: payments.reduce((sum, p) => sum + BigInt(p.changeFils ?? '0'), 0n).toString(),
    cashierName: d.display_name_ar
      ? { displayNameAr: d.display_name_ar, displayNameEn: d.display_name_en! }
      : null,
    shiftNumber: d.shift_number,
    deviceCode: d.device_code,
    printCount: d.print_count,
    markCopies: markCopies?.v ?? true,
    // Today's receipt design, also for a reprint (decision 0071).
    template: await settingsOf(db, null, 'receipt_thermal'),
  };
}

/** Counts a print of the receipt; a print after the first is a reprint (documents.reprint). */
export async function receiptPrinted(
  trx: Transaction<DB>,
  auth: { permissions: ReadonlySet<string> } | null,
  documentId: bigint,
): Promise<{ printCount: number }> {
  const d = await trx
    .selectFrom('sales.documents')
    .select('print_count')
    .where('id', '=', documentId)
    .executeTakeFirst();
  if (!d) throw new AppError('NOT_FOUND', 'No such document');
  if (d.print_count > 0) requireAlso(auth, 'documents.reprint');
  return { printCount: await countPrint(trx, documentId) };
}
