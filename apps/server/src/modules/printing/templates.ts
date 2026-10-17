/**
 * Bilingual A4 templates (design 09; PRD §10.2; decisions 0020, 0064). One HTML per document,
 * rendered to PDF by the server's headless Chromium. The template version's settings choose the
 * look (language, logo, colour, text size, margins, texts) and the optional fields. Fields that
 * UAE VAT law requires on a tax document (decision 0064) are printed whatever the settings say:
 * the title, the seller's name, address and TRN, the customer's name, address and TRN on a full
 * tax invoice, the number and dates, per line the description, quantity, unit price, discount
 * (when any), taxable amount, VAT rate, VAT and total, the totals, earlier payments deducted, and
 * on a credit note the original invoice and the reason.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { amountInWordsAr, amountInWordsEn, formatIban } from '@artepool/shared';
import {
  shows,
  type DesignedKind,
  type OptionalField,
  type TemplateSettings,
} from '@artepool/shared/contracts';

export interface Seller {
  legal_name_ar: string;
  legal_name_en: string;
  trn: string | null;
  address_ar: string;
  address_en: string;
  phone?: string | null;
  email?: string | null;
}

export interface PrintLine {
  descriptionAr: string;
  descriptionEn: string;
  itemCode?: string | null;
  quantityMilli: string;
  unitPrice4dp: string;
  discountFils: string;
  netFils: string;
  vatRateBp: number;
  vatFils: string;
  grossFils: string;
  deduction?: boolean;
}

export interface PrintBankAccount {
  bankName: string;
  accountName: string;
  iban: string;
  swift: string | null;
}

export interface PrintDocument {
  kind:
    | 'invoice'
    | 'advance_invoice'
    | 'credit_note'
    | 'debit_note'
    | 'quotation'
    | 'receipt'
    | 'statement';
  format?: 'full' | 'simplified';
  number: string | null;
  status: 'draft' | 'final';
  copy: boolean;
  dates: { label: [string, string]; value: string }[];
  /** Printed only when the template's "Due date" field is on. */
  dueDate?: string | null;
  customer: {
    name: string;
    nameAlt?: string | null;
    trn?: string | null;
    address?: string | null;
    phone?: string | null;
  };
  customerPo?: string | null;
  salesperson?: string | null;
  reference?: { label: [string, string]; value: string } | null;
  /** A credit or debit note: the original tax invoice (number and date) and the reason. Locked. */
  original?: { number: string; date: string | null } | null;
  reason?: string | null;
  lines: PrintLine[];
  totals: { label: [string, string]; fils: string; strong?: boolean }[];
  /** The amount written in words (the total payable or received). */
  wordsFils?: string | null;
  /** Extra tables (a receipt's allocations, a statement's movements). */
  table?: { head: [string, string][]; rows: string[][] } | null;
  notes?: string | null;
  logoDataUri?: string | null;
}

export interface RenderOptions {
  /** Which template's fields apply: receipts and statements use the A4 invoice's. */
  kind: DesignedKind;
  settings: TemplateSettings;
  bankAccount?: PrintBankAccount | null;
}

const TAX_KINDS = new Set(['invoice', 'advance_invoice', 'credit_note', 'debit_note']);
const MARGINS_MM = { narrow: 8, normal: 12, wide: 18 } as const;
const TEXT_PT = { small: 8.5, normal: 9.5, large: 10.5 } as const;

const fontFile = (name: string): string => {
  const require = createRequire(import.meta.url);
  const dir = dirname(require.resolve('@fontsource/ibm-plex-sans-arabic/package.json'));
  return readFileSync(join(dir, 'files', name)).toString('base64');
};

/** The owner's Arabic font (decision 0068), for Arabic letters only (it draws 0-9 as Arabic-Indic). */
const ARABIC_FONT = new URL('../../../../../assets/fonts/ge-ss-tv-medium.otf', import.meta.url);
const ARABIC_LETTERS =
  'U+0600-065F, U+066A-06EF, U+06FA-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF';

/** English headings (decision 0068): Tw Cen MT Condensed Extra Bold, Latin letters and digits only. */
const HEADING_FONT = new URL(
  '../../../../../assets/fonts/tw-cen-mt-condensed-extra-bold.ttf',
  import.meta.url,
);
const LATIN = 'U+0020-007E, U+00A0-00FF, U+2013-2014, U+2018-201E, U+2022, U+2026, U+20AC';

let fontsCss: string | null = null;
/** The app's fonts, embedded, so Arabic is shaped the same on every server. */
function fonts(): string {
  fontsCss ??=
    `@font-face { font-family: 'ARTEPOOL Arabic'; font-weight: 100 900; unicode-range: ${ARABIC_LETTERS};
      src: url(data:font/otf;base64,${readFileSync(ARABIC_FONT).toString('base64')}) format('opentype'); }\n` +
    `@font-face { font-family: 'ARTEPOOL Heading'; font-weight: 100 900; unicode-range: ${LATIN};
      src: url(data:font/ttf;base64,${readFileSync(HEADING_FONT).toString('base64')}) format('truetype'); }\n` +
    ['arabic', 'latin']
      .flatMap((subset) =>
        [400, 700].map(
          (weight) => `@font-face { font-family: 'Plex Arabic'; font-weight: ${weight};
          src: url(data:font/woff2;base64,${fontFile(`ibm-plex-sans-arabic-${subset}-${weight}-normal.woff2`)}) format('woff2'); }`,
        ),
      )
      .join('\n');
  return fontsCss;
}

export const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Fils → "1,234.56" (always Latin digits on tax documents). */
export function money(fils: string | bigint): string {
  const n = BigInt(fils);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** 4-decimal price → at least 2 decimals, up to 4 when needed. */
export function price(p4: string | bigint): string {
  const n = BigInt(p4);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const whole = (abs / 10000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % 10000n)
    .toString()
    .padStart(4, '0')
    .replace(/0{1,2}$/, '');
  return `${sign}${whole}.${frac.length < 2 ? frac.padEnd(2, '0') : frac}`;
}

export function quantity(milli: string | bigint): string {
  const n = BigInt(milli);
  const frac = (n % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${n / 1000n}${frac ? `.${frac}` : ''}`;
}

/** yyyy-mm-dd → dd/mm/yyyy. */
export const date = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/** "ضريبة القيمة المضافة 5% · VAT 5%": the VAT total with its rate when every line has the same one. */
export function vatLabel(lines: { vatRateBp: number }[]): [string, string] {
  const rates = [...new Set(lines.map((l) => l.vatRateBp))];
  if (rates.length !== 1) return ['ضريبة القيمة المضافة', 'VAT'];
  const pct = `${(rates[0]! / 100).toFixed(rates[0]! % 100 === 0 ? 0 : 2)}%`;
  return [`ضريبة القيمة المضافة ${pct}`, `VAT ${pct}`];
}

const TITLES: Record<string, [string, string]> = {
  'invoice:full': ['فاتورة ضريبية', 'Tax Invoice'],
  'invoice:simplified': ['فاتورة ضريبية مبسطة', 'Simplified Tax Invoice'],
  'advance_invoice:full': ['فاتورة ضريبية — دفعة مستلمة', 'Tax Invoice — Payment Received'],
  'advance_invoice:simplified': [
    'فاتورة ضريبية مبسطة — دفعة مستلمة',
    'Simplified Tax Invoice — Payment Received',
  ],
  'credit_note:full': ['إشعار دائن ضريبي', 'Tax Credit Note'],
  'credit_note:simplified': ['إشعار دائن ضريبي', 'Tax Credit Note'],
  'debit_note:full': ['إشعار مدين ضريبي', 'Tax Debit Note'],
  'debit_note:simplified': ['إشعار مدين ضريبي', 'Tax Debit Note'],
  quotation: ['عرض سعر', 'Quotation'],
  receipt: ['سند قبض', 'Receipt'],
  statement: ['كشف حساب', 'Statement of Account'],
};

export function renderHtml(doc: PrintDocument, seller: Seller, options: RenderOptions): string {
  const { kind, settings } = options;
  const lang = settings.language;
  const isTax = TAX_KINDS.has(doc.kind);
  const full = isTax && doc.format === 'full';
  const on = (field: OptionalField) => shows(kind, settings, field);

  // Locked on tax documents (decision 0064); optional elsewhere.
  const sellerAddress = isTax || on('sellerAddress');
  const sellerTrn = isTax || on('sellerTrn');
  const customerAddress = full || on('customerAddress');
  const anyDiscount = doc.lines.some((l) => BigInt(l.discountFils) !== 0n);
  const discountColumn = (isTax && anyDiscount) || on('lineDiscount');

  const t = (pair: [string, string]): string =>
    lang === 'ar'
      ? escapeHtml(pair[0])
      : lang === 'en'
        ? escapeHtml(pair[1])
        : `${escapeHtml(pair[0])}<span class="en">${escapeHtml(pair[1])}</span>`;
  /** A short label on one line: "الرقم الضريبي · TRN". */
  const inline = (pair: [string, string]): string =>
    lang === 'ar'
      ? escapeHtml(pair[0])
      : lang === 'en'
        ? escapeHtml(pair[1])
        : `${escapeHtml(pair[0])} · ${escapeHtml(pair[1])}`;
  /** A heading on one line, both languages the same size: "ملاحظات • Notes". */
  const heading = (pair: [string, string]): string =>
    lang === 'ar'
      ? escapeHtml(pair[0])
      : lang === 'en'
        ? escapeHtml(pair[1])
        : `${escapeHtml(pair[0])} <span class="sep">•</span> <bdi>${escapeHtml(pair[1])}</bdi>`;
  /** "الرقم الضريبي · TRN 100…": the label isolated, so the number never jumps around it. */
  const trnLine = (trn: string): string =>
    `<span class="pair">${inline(['الرقم الضريبي', 'TRN'])}</span> <span class="ltr">${escapeHtml(trn)}</span>`;
  const title = TITLES[doc.format ? `${doc.kind}:${doc.format}` : doc.kind] ?? TITLES[doc.kind]!;
  const dir = lang === 'en' ? 'ltr' : 'rtl';
  const text = (ar?: string, en?: string) =>
    [lang !== 'en' ? ar : '', lang !== 'ar' ? en : '']
      .filter(Boolean)
      .map((s) => `<p>${escapeHtml(s!)}</p>`)
      .join('');
  const row = (label: [string, string], value: string) =>
    `<div class="row"><span>${t(label)}</span><span class="ltr">${escapeHtml(value)}</span></div>`;

  const logo =
    on('logo') && doc.logoDataUri
      ? `<img class="logo" src="${doc.logoDataUri}" alt="" style="max-block-size:${settings.logoSizeMm}mm">`
      : '';
  const contact = on('sellerContact')
    ? [seller.phone, seller.email].filter(Boolean).map((v) => escapeHtml(v!))
    : [];

  const lineRows = doc.lines
    .map(
      (l, i) => `<tr class="${l.deduction ? 'deduction' : ''}">
        <td class="num">${i + 1}</td>
        <td>${lang !== 'en' ? `<div>${escapeHtml(l.descriptionAr)}</div>` : ''}${lang !== 'ar' ? `<div class="en">${escapeHtml(l.descriptionEn)}</div>` : ''}${on('itemCode') && l.itemCode ? `<div class="code ltr">${escapeHtml(l.itemCode)}</div>` : ''}</td>
        <td class="num">${quantity(l.quantityMilli)}</td>
        <td class="num">${price(l.unitPrice4dp)}</td>
        ${discountColumn ? `<td class="num">${money(l.discountFils)}</td>` : ''}
        <td class="num">${money(l.netFils)}</td>
        <td class="num">${(l.vatRateBp / 100).toFixed(l.vatRateBp % 100 === 0 ? 0 : 2)}%</td>
        <td class="num">${money(l.vatFils)}</td>
        <td class="num">${money(l.grossFils)}</td>
      </tr>`,
    )
    .join('');

  const bank = on('bankDetails') ? options.bankAccount : null;
  const words =
    on('amountInWords') && doc.wordsFils != null && BigInt(doc.wordsFils) >= 0n
      ? text(amountInWordsAr(BigInt(doc.wordsFils)), amountInWordsEn(BigInt(doc.wordsFils)))
      : '';

  return `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'ar'}" dir="${dir}">
<head><meta charset="utf-8"><title>${escapeHtml(doc.number ?? title[1])}</title>
<style>
${fonts()}
@page { size: A4; margin: ${MARGINS_MM[settings.margins]}mm; }
:root { --main: ${escapeHtml(settings.color)}; }
* { box-sizing: border-box; }
html { background: #fff; }
body { font-family: 'ARTEPOOL Arabic', 'Plex Arabic', sans-serif; font-size: ${TEXT_PT[settings.textSize]}pt; color: #111; margin: 0; }
.en { display: block; font-size: 0.85em; color: #444; direction: ltr; unicode-bidi: isolate; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; border-block-end: 1.5pt solid var(--main); padding-block-end: 4mm; }
header.opposite { flex-direction: row-reverse; }
header.center { flex-direction: column; align-items: center; text-align: center; }
header.center .logo { order: -1; }
.logo { max-inline-size: 60mm; }
h1, h2, h3, .heading { font-family: 'ARTEPOOL Arabic', 'ARTEPOOL Heading', 'Plex Arabic', sans-serif; }
.seller h1 { font-size: 1.35em; margin: 0; color: #111; }
.seller p { margin: 0.5mm 0; }
.title { text-align: center; margin: 5mm 0 3mm; }
.title h2 { font-size: 1.55em; margin: 0; color: #111; }
.welcome { text-align: center; color: #333; }
.sep { color: #888; font-weight: 400; }
.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm 8mm; margin-block-end: 4mm; }
.box { border: 0.8pt solid #999; border-radius: 2mm; padding: 2.5mm 3mm; }
.box h3 { font-size: 1em; margin: 0 0 1.5mm; color: #111; }
.row { display: flex; justify-content: space-between; gap: 4mm; }
.ltr { direction: ltr; unicode-bidi: isolate; }
.code { font-size: 0.85em; color: #555; }
table { inline-size: 100%; border-collapse: collapse; }
th, td { border: 0.6pt solid #bbb; padding: 1.5mm 1.8mm; vertical-align: top; }
th { background: var(--main); color: #fff; font-weight: 700; font-size: 0.9em; }
th .en { color: #eee; }
td.num, th.num { text-align: end; white-space: nowrap; direction: ltr; unicode-bidi: isolate; }
tr.deduction td { color: #333; font-style: italic; }
.after { display: flex; gap: 8mm; align-items: flex-start; margin-block-start: 3mm; }
.after .side { flex: 1; }
.totals { margin-inline-start: auto; inline-size: 75mm; }
.totals .row { padding: 1mm 0; border-block-end: 0.5pt solid #ddd; }
.totals .strong { font-weight: 700; font-size: 1.15em; border-block-end: 1.5pt solid var(--main); color: var(--main); }
.words, .bank, .notes { margin-block-start: 3mm; }
.notes h3, .bank h3 { font-size: 1em; margin: 0 0 1mm; color: #111; }
.notes p, .bank p { margin: 0.5mm 0; }
.notes, .bank, .words { border-block-start: 0.5pt solid #ddd; padding-block-start: 2mm; }
.pair { unicode-bidi: isolate; }
.sign { display: grid; grid-template-columns: 1fr 1fr; gap: 12mm; margin-block-start: 12mm; }
.sign div { border-block-start: 0.8pt solid #555; padding-block-start: 1.5mm; text-align: center; }
footer { margin-block-start: 8mm; text-align: center; color: #555; font-size: 0.9em; }
.stamp { position: fixed; inset-block-start: 40%; inset-inline: 0; text-align: center; font-size: 60pt; color: rgba(0,0,0,0.08); transform: rotate(-20deg); font-weight: 700; }
</style></head>
<body>
${doc.status === 'draft' ? `<div class="stamp">${t(['مسودة', 'DRAFT'])}</div>` : doc.copy ? `<div class="stamp">${t(['نسخة', 'COPY'])}</div>` : ''}
<header class="${settings.logoPosition}">
  <div class="seller">
    <h1>${lang !== 'en' ? escapeHtml(seller.legal_name_ar) : ''}${lang !== 'ar' ? `<span class="en">${escapeHtml(seller.legal_name_en)}</span>` : ''}</h1>
    ${sellerAddress ? text(seller.address_ar, seller.address_en) : ''}
    ${sellerTrn && seller.trn ? `<p>${trnLine(seller.trn)}</p>` : ''}
    ${contact.length > 0 ? `<p><span class="ltr">${contact.join(' · ')}</span></p>` : ''}
  </div>
  ${logo}
</header>
<div class="title"><h2>${heading(title)}</h2>${doc.copy && doc.status === 'final' ? `<div>${t(['نسخة', 'Copy'])}</div>` : ''}</div>
${on('welcome') ? `<div class="welcome">${text(settings.texts.welcomeAr, settings.texts.welcomeEn)}</div>` : ''}
<section class="meta">
  <div class="box">
    <h3>${heading(['العميل', 'Bill to'])}</h3>
    <div><strong>${escapeHtml(doc.customer.name)}</strong></div>
    ${doc.customer.nameAlt ? `<div>${escapeHtml(doc.customer.nameAlt)}</div>` : ''}
    ${customerAddress && doc.customer.address ? `<div>${escapeHtml(doc.customer.address)}</div>` : ''}
    ${doc.customer.trn ? `<div>${trnLine(doc.customer.trn)}</div>` : ''}
    ${on('customerPhone') && doc.customer.phone ? `<div><span class="ltr">${escapeHtml(doc.customer.phone)}</span></div>` : ''}
  </div>
  <div class="box">
    ${row(['الرقم', 'Number'], doc.number ?? '—')}
    ${doc.dates.map((d) => row(d.label, d.value)).join('')}
    ${on('dueDate') && doc.dueDate ? row(['تاريخ الاستحقاق', 'Due date'], doc.dueDate) : ''}
    ${doc.original ? row(['الفاتورة الأصلية', 'Original invoice'], doc.original.number) : ''}
    ${doc.original?.date ? row(['تاريخ الفاتورة الأصلية', 'Original invoice date'], doc.original.date) : ''}
    ${on('poNumber') && doc.customerPo ? row(['أمر شراء العميل', 'Customer PO'], doc.customerPo) : ''}
    ${on('salesperson') && doc.salesperson ? row(['مندوب المبيعات', 'Salesperson'], doc.salesperson) : ''}
    ${doc.reference ? row(doc.reference.label, doc.reference.value) : ''}
  </div>
</section>
${
  doc.lines.length > 0
    ? `<table>
  <thead><tr>
    <th class="num">#</th><th>${t(['الوصف', 'Description'])}</th><th class="num">${t(['الكمية', 'Qty'])}</th>
    <th class="num">${t(['سعر الوحدة', 'Unit price'])}</th>${discountColumn ? `<th class="num">${t(['الخصم', 'Discount'])}</th>` : ''}
    <th class="num">${t(['المبلغ الخاضع', 'Taxable'])}</th><th class="num">${t(['النسبة', 'VAT %'])}</th>
    <th class="num">${t(['الضريبة', 'VAT'])}</th><th class="num">${t(['الإجمالي', 'Total'])}</th>
  </tr></thead>
  <tbody>${lineRows}</tbody>
</table>`
    : ''
}
${
  doc.table
    ? `<table><thead><tr>${doc.table.head.map((h, i) => `<th class="${i > 0 ? 'num' : ''}">${t(h)}</th>`).join('')}</tr></thead>
  <tbody>${doc.table.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i > 0 ? 'num' : ''}">${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : ''
}
<section class="after">
  <div class="side">
    ${words ? `<div class="words">${words}</div>` : ''}
    ${
      bank
        ? `<div class="bank"><h3>${heading(['بيانات البنك', 'Bank details'])}</h3>
      <p>${escapeHtml(bank.bankName)} · ${escapeHtml(bank.accountName)}</p>
      <p><span class="ltr">IBAN: ${escapeHtml(formatIban(bank.iban))}${bank.swift ? ` · SWIFT: ${escapeHtml(bank.swift)}` : ''}</span></p></div>`
        : ''
    }
  </div>
  <div class="totals">
    ${doc.totals.map((x) => `<div class="row ${x.strong ? 'strong' : ''}"><span>${t(x.label)}</span><span class="ltr">${money(x.fils)} AED</span></div>`).join('')}
  </div>
</section>
${doc.reason ? `<section class="notes"><h3>${heading(['سبب الإشعار', 'Reason'])}</h3><p>${escapeHtml(doc.reason)}</p></section>` : ''}
${on('notes') && doc.notes ? `<section class="notes"><h3>${heading(['ملاحظات', 'Notes'])}</h3><p>${escapeHtml(doc.notes)}</p></section>` : ''}
${on('terms') && (settings.texts.termsAr || settings.texts.termsEn) ? `<section class="notes">${text(settings.texts.termsAr, settings.texts.termsEn)}</section>` : ''}
${on('signature') ? `<section class="sign"><div>${t(['استلمت البضاعة', 'Received by'])}</div><div>${t(['الختم والتوقيع', 'Stamp & signature'])}</div></section>` : ''}
<footer>${text(settings.texts.footerAr, settings.texts.footerEn)}</footer>
</body></html>`;
}
