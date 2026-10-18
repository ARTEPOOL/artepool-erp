/**
 * The thermal receipt's content (design 10, decisions 0008, 0062, 0070): a list of simple lines
 * that the drawing step turns into an image. The look follows the owner's sample: the seller
 * centred at the top, the title, number and date on one line, an Item / Amount table with a
 * separator between items, the totals, a large total and a "Paid" box. Arabic and English together by default (setting
 * `print.receipt_language`); the receipt reads right to left unless it is English only. Every label
 * comes from the translations, in both languages at once.
 */
import {
  amountInWordsAr,
  amountInWordsEn,
  formatFils,
  formatQuantity,
  roundDiv,
} from '@artepool/shared';
import { defaultTemplateSettings, shows, type ReceiptData } from '@artepool/shared/contracts';
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
  /** One sold line: its name (one per language), "qty × price" under it, the amount at the end. */
  | { kind: 'item'; names: string[]; detail: string; value: string }
  /** A framed word across the paper ("Paid"). */
  | { kind: 'box'; text: string }
  /** dashed (sections), dotted (between items), solid (under the table head), heavy (total). */
  | { kind: 'rule'; heavy?: boolean; style?: 'dashed' | 'dotted' | 'solid' }
  | { kind: 'space' };

export interface ReceiptModel {
  dir: 'rtl' | 'ltr';
  lines: ReceiptLine[];
  /** 80 mm (576 dots, the default) or 58 mm (384 dots) paper (decision 0064). */
  paperWidthMm?: 80 | 58;
  /** Draw the company logo at the top (the template's "Logo" field). */
  logo?: boolean;
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
  // The template version stored on the document decides the optional fields (decision 0064);
  // the locked ones (seller name, address and TRN, number, date, lines, VAT, totals, and the
  // customer's name, address and TRN on a full tax invoice) are always printed.
  const template = data.template ?? defaultTemplateSettings('receipt_thermal');
  const on = (field: Parameters<typeof shows>[2]) => shows('receipt_thermal', template, field);
  const both = language === 'both';
  const ar = language !== 'en';
  /** A label in the receipt's language(s): "رقم / No." */
  const label = (key: string, options?: Record<string, unknown>) =>
    both
      ? `${t.ar(key, options).trim()} / ${t.en(key, options).trim()}`
      : (ar ? t.ar : t.en)(key, options).trim();
  const pick = (arText: string, enText: string) =>
    both ? [arText, enText].filter(Boolean) : [ar ? arText : enText];
  /** Numbers, codes and dates keep reading left to right inside Arabic (a bidi isolate). */
  const iso = (value: string) => (language === 'en' || !value ? value : `\u2066${value}\u2069`);
  const doc = data.document;
  const lines: ReceiptLine[] = [];
  const text = (value: string, size: 's' | 'm' | 'l' = 's', bold = false) =>
    lines.push({ kind: 'text', text: value, align: 'center', size, bold });

  // The seller, as frozen on the document, centred like a letterhead.
  pick(data.seller.nameAr, data.seller.nameEn).forEach((name, i) =>
    text(name, i === 0 ? 'l' : 'm', true),
  );
  const address = pick(data.seller.addressAr, data.seller.addressEn).join(' · ');
  if (address) text(address);
  /**
   * A labelled seller line. In both languages the Arabic label stays on the right and the English
   * one on the left, with the value between them: "Tel: +971… :هاتف" (as on the A4 invoice).
   */
  const sellerLine = (key: string, value: string) =>
    text(
      both
        ? `${t.ar(key).trim()}: ${`\u2066${t.en(key).trim()}: ${value}\u2069`}`
        : `${label(key)}: ${iso(value)}`,
    );
  if (on('sellerContact')) {
    if (data.seller.phone) sellerLine('receipt.phone', data.seller.phone);
    if (data.seller.email) sellerLine('receipt.email', data.seller.email);
  }
  if (data.seller.trn) sellerLine('receipt.trn', data.seller.trn);
  if (on('welcome'))
    for (const w of pick(template.texts.welcomeAr, template.texts.welcomeEn)) if (w) text(w);
  lines.push({ kind: 'rule' });

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

  // Number and date on one line, then who it is for and who served.
  lines.push({
    kind: 'pair',
    label: iso(`#${doc.docNumber ?? ''}`),
    value: doc.issuedAt ? iso(formatDateTime(doc.issuedAt)) : '',
  });
  if (doc.originalDocumentNumber) {
    lines.push({
      kind: 'pair',
      label: label('receipt.original'),
      value: iso(doc.originalDocumentNumber),
    });
  }
  const full = doc.invoiceFormat === 'full';
  lines.push({ kind: 'pair', label: label('receipt.customer'), value: doc.billToName });
  if (full || doc.billToTrn) {
    // On a full tax invoice the customer's address is required (decision 0064).
    if (doc.billToAddress && (full || on('customerAddress'))) {
      lines.push({
        kind: 'pair',
        label: label('receipt.customerAddress'),
        value: doc.billToAddress,
      });
    }
    if (doc.billToTrn) {
      lines.push({
        kind: 'pair',
        label: label('receipt.customerTrn'),
        value: iso(doc.billToTrn),
      });
    }
    if (doc.billToPhone && on('customerPhone')) {
      lines.push({
        kind: 'pair',
        label: label('receipt.customerPhone'),
        value: iso(doc.billToPhone),
      });
    }
  }
  if (data.cashierName && on('cashierName')) {
    const cashier = ar ? data.cashierName.displayNameAr : data.cashierName.displayNameEn;
    lines.push({
      kind: 'pair',
      label: label('receipt.cashier'),
      value: [cashier, data.shiftNumber ? iso(data.shiftNumber) : ''].filter(Boolean).join(' · '),
    });
  }
  lines.push({ kind: 'pair', label: label('receipt.device'), value: iso(data.deviceCode) });
  lines.push({ kind: 'rule' });

  // The table: Item / Amount, then each line with a separator between lines.
  lines.push({
    kind: 'pair',
    label: label('receipt.item'),
    value: label('receipt.amount'),
    bold: true,
  });
  lines.push({ kind: 'rule', style: 'solid' });
  let pieces = 0n;
  let anyInclusive = false;
  const sold = doc.lines.filter((l) => l.lineKind === 'item');
  sold.forEach((l, i) => {
    if (i > 0) lines.push({ kind: 'rule', style: 'dotted' });
    // Shown to the fils through the shared rounding helper (golden rule 1).
    const shownUnit = formatFils(roundDiv(BigInt(l.unitPrice4dp), 100n));
    lines.push({
      kind: 'item',
      names: pick(l.descriptionAr, l.descriptionEn).filter(Boolean),
      detail: `${l.itemCode && on('itemCode') ? `${l.itemCode} · ` : ''}${quantity(l.quantityMilli)} × ${shownUnit}`,
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
  });
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
  if (on('amountInWords') && BigInt(doc.totalFils) >= 0n) {
    for (const w of pick(
      amountInWordsAr(BigInt(doc.totalFils)),
      amountInWordsEn(BigInt(doc.totalFils)),
    ))
      text(w);
  }
  const paid = data.payments.reduce((sum, p) => sum + BigInt(p.amountFils), 0n);
  if (data.payments.length > 0 && paid >= BigInt(doc.totalFils)) {
    lines.push({
      kind: 'box',
      text: label(doc.docType === 'credit_note' ? 'receipt.refunded' : 'receipt.paid'),
    });
  }
  lines.push({ kind: 'rule' });

  // Payments, change, card approval codes (never a card number, 0061).
  for (const p of data.payments) {
    const method = both
      ? `${p.methodNameAr} / ${p.methodNameEn}`
      : ar
        ? p.methodNameAr
        : p.methodNameEn;
    lines.push({ kind: 'pair', label: method, value: money(p.tenderedFils ?? p.amountFils) });
    if (p.reference && p.methodKind === 'card') {
      lines.push({ kind: 'pair', label: label('receipt.approvalCode'), value: iso(p.reference) });
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
  if (on('terms'))
    for (const term of pick(template.texts.termsAr, template.texts.termsEn)) if (term) text(term);
  const footer = pick(template.texts.footerAr, template.texts.footerEn).filter(Boolean);
  text(
    (footer.length > 0 ? footer : pick(t.ar('receipt.thanks'), t.en('receipt.thanks'))).join(' · '),
    'm',
    true,
  );
  return {
    dir: language === 'en' ? 'ltr' : 'rtl',
    lines,
    paperWidthMm: template.paperWidthMm,
    logo: on('logo'),
  };
}
