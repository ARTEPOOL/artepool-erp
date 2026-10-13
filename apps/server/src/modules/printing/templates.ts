/**
 * Bilingual A4 templates (design 09; PRD §10.2). One HTML per document, rendered to PDF by the
 * server's headless Chromium. Tax-required content is always printed and cannot be switched off
 * (decision 0020): the title and type, the seller's name, address and TRN, the number and dates,
 * the customer's TRN on a full tax invoice, and per line the price, discount, net, VAT rate, VAT and
 * total, with the taxable amount, VAT and total payable. The template version's settings only
 * choose the language, logo, optional fields and texts.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface TemplateSettings {
  language?: 'both' | 'ar' | 'en';
  showLogo?: boolean;
  optional?: Partial<
    Record<
      'salesperson' | 'dueDate' | 'customerPhone' | 'lineDiscount' | 'notes' | 'bankDetails',
      boolean
    >
  >;
  texts?: Partial<
    Record<'welcomeAr' | 'welcomeEn' | 'termsAr' | 'termsEn' | 'footerAr' | 'footerEn', string>
  >;
}

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
  quantityMilli: string;
  unitPrice4dp: string;
  discountFils: string;
  netFils: string;
  vatRateBp: number;
  vatFils: string;
  grossFils: string;
  deduction?: boolean;
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
  customer: {
    name: string;
    nameAlt?: string | null;
    trn?: string | null;
    address?: string | null;
    phone?: string | null;
  };
  reference?: { label: [string, string]; value: string } | null;
  lines: PrintLine[];
  totals: { label: [string, string]; fils: string; strong?: boolean }[];
  /** Extra tables (a receipt's allocations, a statement's movements). */
  table?: { head: [string, string][]; rows: string[][] } | null;
  notes?: string | null;
  logoDataUri?: string | null;
}

const fontFile = (name: string): string => {
  const require = createRequire(import.meta.url);
  const dir = dirname(require.resolve('@fontsource/ibm-plex-sans-arabic/package.json'));
  return readFileSync(join(dir, 'files', name)).toString('base64');
};

let fontsCss: string | null = null;
/** The app's font, embedded, so Arabic is shaped the same on every server. */
function fonts(): string {
  fontsCss ??= ['arabic', 'latin']
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

export function renderHtml(doc: PrintDocument, seller: Seller, settings: TemplateSettings): string {
  const lang = settings.language ?? 'both';
  const opt = {
    lineDiscount: true,
    customerPhone: true,
    notes: true,
    ...(settings.optional ?? {}),
  };
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
  const title = TITLES[doc.format ? `${doc.kind}:${doc.format}` : doc.kind] ?? TITLES[doc.kind]!;
  const dir = lang === 'en' ? 'ltr' : 'rtl';
  const text = (ar?: string, en?: string) =>
    [lang !== 'en' ? ar : '', lang !== 'ar' ? en : '']
      .filter(Boolean)
      .map((s) => `<p>${escapeHtml(s!)}</p>`)
      .join('');

  const lineRows = doc.lines
    .map(
      (l, i) => `<tr class="${l.deduction ? 'deduction' : ''}">
        <td class="num">${i + 1}</td>
        <td>${lang !== 'en' ? `<div>${escapeHtml(l.descriptionAr)}</div>` : ''}${lang !== 'ar' ? `<div class="en">${escapeHtml(l.descriptionEn)}</div>` : ''}</td>
        <td class="num">${quantity(l.quantityMilli)}</td>
        <td class="num">${price(l.unitPrice4dp)}</td>
        ${opt.lineDiscount ? `<td class="num">${money(l.discountFils)}</td>` : ''}
        <td class="num">${money(l.netFils)}</td>
        <td class="num">${(l.vatRateBp / 100).toFixed(l.vatRateBp % 100 === 0 ? 0 : 2)}%</td>
        <td class="num">${money(l.vatFils)}</td>
        <td class="num">${money(l.grossFils)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="${lang === 'en' ? 'en' : 'ar'}" dir="${dir}">
<head><meta charset="utf-8"><title>${escapeHtml(doc.number ?? title[1])}</title>
<style>
${fonts()}
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { font-family: 'Plex Arabic', sans-serif; font-size: 9.5pt; color: #111; margin: 0; }
.en { display: block; font-size: 0.85em; color: #444; direction: ltr; unicode-bidi: isolate; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; border-block-end: 1.5pt solid #111; padding-block-end: 4mm; }
header img { max-block-size: 22mm; max-inline-size: 45mm; }
.seller h1 { font-size: 13pt; margin: 0; }
.seller p { margin: 0.5mm 0; }
.title { text-align: center; margin: 5mm 0 3mm; }
.title h2 { font-size: 15pt; margin: 0; }
.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm 8mm; margin-block-end: 4mm; }
.box { border: 0.8pt solid #999; border-radius: 2mm; padding: 2.5mm 3mm; }
.box h3 { font-size: 9pt; margin: 0 0 1mm; color: #333; }
.row { display: flex; justify-content: space-between; gap: 4mm; }
.ltr { direction: ltr; unicode-bidi: isolate; }
table { inline-size: 100%; border-collapse: collapse; }
th, td { border: 0.6pt solid #bbb; padding: 1.5mm 1.8mm; vertical-align: top; }
th { background: #f0f0f0; font-weight: 700; font-size: 8.5pt; }
td.num, th.num { text-align: end; white-space: nowrap; direction: ltr; unicode-bidi: isolate; }
tr.deduction td { color: #333; font-style: italic; }
.totals { margin-block-start: 3mm; margin-inline-start: auto; inline-size: 75mm; }
.totals .row { padding: 1mm 0; border-block-end: 0.5pt solid #ddd; }
.totals .strong { font-weight: 700; font-size: 11pt; border-block-end: 1.5pt solid #111; }
.notes { margin-block-start: 5mm; }
footer { margin-block-start: 8mm; text-align: center; color: #555; font-size: 8.5pt; }
.stamp { position: fixed; inset-block-start: 40%; inset-inline: 0; text-align: center; font-size: 60pt; color: rgba(0,0,0,0.08); transform: rotate(-20deg); font-weight: 700; }
</style></head>
<body>
${doc.status === 'draft' ? `<div class="stamp">${t(['مسودة', 'DRAFT'])}</div>` : doc.copy ? `<div class="stamp">${t(['نسخة', 'COPY'])}</div>` : ''}
<header>
  <div class="seller">
    <h1>${lang !== 'en' ? escapeHtml(seller.legal_name_ar) : ''}${lang !== 'ar' ? `<span class="en">${escapeHtml(seller.legal_name_en)}</span>` : ''}</h1>
    ${text(seller.address_ar, seller.address_en)}
    ${seller.trn ? `<p>${inline(['الرقم الضريبي', 'TRN'])}: <span class="ltr">${escapeHtml(seller.trn)}</span></p>` : ''}
    ${seller.phone ? `<p class="ltr">${escapeHtml(seller.phone)}</p>` : ''}
  </div>
  ${settings.showLogo !== false && doc.logoDataUri ? `<img src="${doc.logoDataUri}" alt="">` : ''}
</header>
<div class="title"><h2>${t(title)}</h2>${doc.copy && doc.status === 'final' ? `<div>${t(['نسخة', 'Copy'])}</div>` : ''}</div>
${text(settings.texts?.welcomeAr, settings.texts?.welcomeEn)}
<section class="meta">
  <div class="box">
    <h3>${t(['العميل', 'Bill to'])}</h3>
    <div><strong>${escapeHtml(doc.customer.name)}</strong></div>
    ${doc.customer.nameAlt ? `<div>${escapeHtml(doc.customer.nameAlt)}</div>` : ''}
    ${doc.customer.address ? `<div>${escapeHtml(doc.customer.address)}</div>` : ''}
    ${doc.customer.trn ? `<div>${inline(['الرقم الضريبي', 'TRN'])}: <span class="ltr">${escapeHtml(doc.customer.trn)}</span></div>` : ''}
    ${opt.customerPhone && doc.customer.phone ? `<div class="ltr">${escapeHtml(doc.customer.phone)}</div>` : ''}
  </div>
  <div class="box">
    <div class="row"><span>${t(['الرقم', 'Number'])}</span><strong class="ltr">${escapeHtml(doc.number ?? '—')}</strong></div>
    ${doc.dates.map((d) => `<div class="row"><span>${t(d.label)}</span><span class="ltr">${escapeHtml(d.value)}</span></div>`).join('')}
    ${doc.reference ? `<div class="row"><span>${t(doc.reference.label)}</span><span class="ltr">${escapeHtml(doc.reference.value)}</span></div>` : ''}
  </div>
</section>
${
  doc.lines.length > 0
    ? `<table>
  <thead><tr>
    <th class="num">#</th><th>${t(['الوصف', 'Description'])}</th><th class="num">${t(['الكمية', 'Qty'])}</th>
    <th class="num">${t(['سعر الوحدة', 'Unit price'])}</th>${opt.lineDiscount ? `<th class="num">${t(['الخصم', 'Discount'])}</th>` : ''}
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
<section class="totals">
  ${doc.totals.map((x) => `<div class="row ${x.strong ? 'strong' : ''}"><span>${t(x.label)}</span><span class="ltr">${money(x.fils)} AED</span></div>`).join('')}
</section>
${opt.notes && doc.notes ? `<section class="notes"><h3>${t(['ملاحظات', 'Notes'])}</h3><p>${escapeHtml(doc.notes)}</p></section>` : ''}
${settings.texts?.termsAr || settings.texts?.termsEn ? `<section class="notes">${text(settings.texts?.termsAr, settings.texts?.termsEn)}</section>` : ''}
<footer>${text(settings.texts?.footerAr, settings.texts?.footerEn)}</footer>
</body></html>`;
}
