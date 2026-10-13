/**
 * The thermal receipt's content (design 10, decisions 0008, 0062): a list of simple lines that the
 * drawing step turns into an image. Arabic and English together by default (setting
 * `print.receipt_language`); the receipt reads right to left unless it is English only. Every label
 * comes from the translations, in both languages at once.
 */
import { formatFils, formatQuantity, roundDiv } from '@artepool/shared';
import type { ReceiptData } from '@artepool/shared/contracts';
import { formatDateTime } from '../../../lib/format';

export type ReceiptLanguage = 'ar' | 'en' | 'both';
type Translate = (key: string, options?: Record<string, unknown>) => string;

export type ReceiptLine =
  | {
      kind: 'text';
      text: string;
      align: 'center' | 'start';
      size: 's' | 'm' | 'l';
      bold?: boolean;
    }
  | { kind: 'pair'; label: string; value: string; size?: 's' | 'm' | 'l'; bold?: boolean }
  | { kind: 'rule'; heavy?: boolean }
  | { kind: 'space' };

export interface ReceiptModel {
  dir: 'rtl' | 'ltr';
  lines: ReceiptLine[];
}

const money = (fils: string | bigint) => formatFils(BigInt(fils));

/** "2" for whole quantities, "1.5" otherwise. */
const quantity = (milli: string) => formatQuantity(BigInt(milli)).replace(/\.?0+$/, '');

export function receiptModel(
  data: ReceiptData,
  language: ReceiptLanguage,
  t: { ar: Translate; en: Translate },
  printedAt: Date = new Date(),
): ReceiptModel {
  const both = language === 'both';
  const ar = language !== 'en';
  /** A label in the receipt's language(s): "رقم / No." */
  const label = (key: string, options?: Record<string, unknown>) =>
    both
      ? `${t.ar(key, options).trim()} / ${t.en(key, options).trim()}`
      : (ar ? t.ar : t.en)(key, options).trim();
  const pick = (arText: string, enText: string) =>
    both ? [arText, enText].filter(Boolean) : [ar ? arText : enText];
  const doc = data.document;
  const lines: ReceiptLine[] = [];
  const text = (value: string, size: 's' | 'm' | 'l' = 's', bold = false) =>
    lines.push({ kind: 'text', text: value, align: 'center', size, bold });

  // The seller, as frozen on the document.
  for (const name of pick(data.seller.nameAr, data.seller.nameEn)) text(name, 'm', true);
  const address = pick(data.seller.addressAr, data.seller.addressEn).join(' · ');
  if (address) text(address);
  const contact = [
    data.seller.trn ? `${label('receipt.trn')}: ${data.seller.trn}` : '',
    data.seller.phone ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (contact) text(contact);
  lines.push({ kind: 'space' });

  // The title: simplified or full tax invoice (0010), or a credit note.
  const titleKey =
    doc.docType === 'credit_note'
      ? 'receipt.titleCreditNote'
      : doc.invoiceFormat === 'full'
        ? 'receipt.titleFull'
        : 'receipt.titleSimplified';
  for (const title of pick(t.ar(titleKey), t.en(titleKey))) text(title, 'm', true);
  if (data.printCount > 0 && data.markCopies) {
    text(label('receipt.copy'), 'm', true);
    text(
      `${label('receipt.reprint', { n: data.printCount })} · ${formatDateTime(printedAt.toISOString())}`,
    );
  }
  lines.push({ kind: 'rule' });

  lines.push({ kind: 'pair', label: label('receipt.number'), value: doc.docNumber ?? '' });
  if (doc.originalDocumentNumber) {
    lines.push({
      kind: 'pair',
      label: label('receipt.original'),
      value: doc.originalDocumentNumber,
    });
  }
  if (doc.issuedAt) {
    lines.push({
      kind: 'pair',
      label: label('receipt.date'),
      value: formatDateTime(doc.issuedAt),
    });
  }
  if (data.cashierName) {
    const cashier = ar ? data.cashierName.displayNameAr : data.cashierName.displayNameEn;
    lines.push({
      kind: 'pair',
      label: label('receipt.cashier'),
      value: [cashier, data.shiftNumber].filter(Boolean).join(' · '),
    });
  }
  lines.push({ kind: 'pair', label: label('receipt.device'), value: data.deviceCode });
  if (doc.invoiceFormat === 'full' || doc.billToTrn) {
    lines.push({ kind: 'pair', label: label('receipt.customer'), value: doc.billToName });
    if (doc.billToTrn) {
      lines.push({ kind: 'pair', label: label('receipt.customerTrn'), value: doc.billToTrn });
    }
  }
  lines.push({ kind: 'rule' });

  // The lines: description, code, quantity × unit price (as the price was given), amount.
  let pieces = 0n;
  let anyInclusive = false;
  for (const l of doc.lines) {
    if (l.lineKind !== 'item') continue;
    for (const d of pick(l.descriptionAr, l.descriptionEn)) {
      lines.push({ kind: 'text', text: d, align: 'start', size: 's', bold: true });
    }
    // Shown to the fils through the shared rounding helper (golden rule 1).
    const shownUnit = formatFils(roundDiv(BigInt(l.unitPrice4dp), 100n));
    lines.push({
      kind: 'pair',
      label: `${l.itemCode ? `${l.itemCode} · ` : ''}${quantity(l.quantityMilli)} × ${shownUnit}`,
      value: money(l.grossFils),
    });
    const discount = BigInt(l.lineDiscountFils) + BigInt(l.docDiscountAllocFils);
    if (discount > 0n) {
      lines.push({
        kind: 'pair',
        label: label('receipt.discount'),
        value: `-${money(discount)}`,
      });
    }
    pieces += BigInt(l.quantityMilli);
    if (l.priceIncludesVat) anyInclusive = true;
  }
  lines.push({ kind: 'rule' });

  // Totals: every tax invoice shows net, VAT and total (0032).
  const rates = [...new Set(doc.lines.map((l) => l.vatRateBp))];
  const ratePct = rates.length === 1 ? `${(rates[0]! / 100).toString()}%` : '';
  lines.push({ kind: 'pair', label: label('receipt.net'), value: money(doc.netFils) });
  lines.push({
    kind: 'pair',
    label: label('receipt.vat', { rate: ratePct }),
    value: money(doc.vatFils),
  });
  if (BigInt(doc.discountTotalFils) > 0n) {
    lines.push({
      kind: 'pair',
      label: label('receipt.discountTotal'),
      value: money(doc.discountTotalFils),
    });
  }
  lines.push({ kind: 'rule', heavy: true });
  lines.push({
    kind: 'pair',
    label: label('receipt.total'),
    value: `${money(doc.totalFils)} ${(language === 'ar' ? t.ar : t.en)('receipt.currency')}`,
    size: 'l',
    bold: true,
  });
  lines.push({ kind: 'rule', heavy: true });

  // Payments, change, card approval codes (never a card number, 0061).
  for (const p of data.payments) {
    const method = both
      ? `${p.methodNameAr} / ${p.methodNameEn}`
      : ar
        ? p.methodNameAr
        : p.methodNameEn;
    lines.push({ kind: 'pair', label: method, value: money(p.tenderedFils ?? p.amountFils) });
    if (p.reference && p.methodKind === 'card') {
      lines.push({ kind: 'pair', label: label('receipt.approvalCode'), value: p.reference });
    }
  }
  if (BigInt(data.changeFils) > 0n) {
    lines.push({
      kind: 'pair',
      label: label('receipt.change'),
      value: money(data.changeFils),
      bold: true,
    });
  }
  lines.push({
    kind: 'pair',
    label: label('receipt.items'),
    value: quantity(pieces.toString()),
  });
  lines.push({ kind: 'rule' });

  if (anyInclusive)
    for (const note of pick(t.ar('receipt.pricesIncludeVat'), t.en('receipt.pricesIncludeVat')))
      text(note);
  text(pick(t.ar('receipt.thanks'), t.en('receipt.thanks')).join(' · '), 's', true);
  return { dir: language === 'en' ? 'ltr' : 'rtl', lines };
}
