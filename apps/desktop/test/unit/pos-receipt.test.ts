/**
 * The thermal receipt (decisions 0008, 0055, 0062): the ESC/POS bytes (reset, drawer kick, raster
 * blocks, feed and cut), the 1-bit packing, and the receipt's content in Arabic, English and both:
 * simplified vs full tax invoice, net / VAT / total, change, the card approval code, copies.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultTemplateSettings,
  type DocumentDetail,
  type ReceiptData,
  type SalesLine,
} from '@artepool/shared/contracts';
import i18n from 'i18next';
import {
  DRAWER_KICK,
  FEED_AND_CUT,
  INIT,
  drawerKickJob,
  receiptJob,
  toBase64,
  toMonochrome,
} from '../../src/features/pos/receipt/escpos';
import { receiptModel, type ReceiptLine } from '../../src/features/pos/receipt/layout';

const line = (over: Partial<SalesLine>): SalesLine =>
  ({
    id: '1',
    lineNo: 1,
    lineKind: 'item',
    itemId: '7',
    itemCode: 'TCCA90-05',
    descriptionAr: 'كلور أقراص',
    descriptionEn: 'TCCA tablets',
    unitId: '1',
    businessLineId: '1',
    quantityMilli: '2000',
    listPrice4dp: '1260000',
    unitPrice4dp: '1260000',
    priceIncludesVat: true,
    amountBeforeDiscountFils: '25200',
    lineDiscountFils: '0',
    docDiscountAllocFils: '0',
    discountExclVatFils: '0',
    netFils: '24000',
    vatCategoryId: '1',
    vatRateBp: 500,
    vatFils: '1200',
    grossFils: '25200',
    ...over,
  }) as SalesLine;

function receipt(over: Partial<ReceiptData> = {}, doc: Partial<DocumentDetail> = {}): ReceiptData {
  return {
    seller: {
      nameAr: 'آرت لتجارة المسابح',
      nameEn: 'ARTEPOOL',
      addressAr: 'العين',
      addressEn: 'Al Ain',
      trn: '100987654300003',
      phone: '+971 3 000 0000',
      email: null,
    },
    document: {
      id: '9',
      docType: 'invoice',
      invoiceFormat: 'simplified',
      docNumber: 'POS-000124',
      issuedAt: '2026-10-07T10:32:00Z',
      billToName: 'Cash customer',
      billToTrn: null,
      originalDocumentNumber: null,
      discountTotalFils: '0',
      netFils: '24000',
      vatFils: '1200',
      totalFils: '25200',
      lines: [line({})],
      ...doc,
    } as DocumentDetail,
    payments: [
      {
        id: '1',
        docNumber: 'RCT-1',
        methodNameAr: 'نقدًا',
        methodNameEn: 'Cash',
        methodKind: 'cash',
        amountFils: '25200',
        tenderedFils: '30000',
        changeFils: '4800',
        reference: null,
      },
    ],
    changeFils: '4800',
    cashierName: { displayNameAr: 'أحمد', displayNameEn: 'Ahmed' },
    shiftNumber: 'Z-000042',
    deviceCode: 'COUNTER-01',
    printCount: 0,
    markCopies: true,
    template: defaultTemplateSettings('receipt_thermal'),
    ...over,
  };
}

const t = () => ({ ar: i18n.getFixedT('ar', 'pos'), en: i18n.getFixedT('en', 'pos') });
const texts = (lines: ReceiptLine[]) =>
  lines.map((l) =>
    l.kind === 'text' ? l.text : l.kind === 'pair' ? `${l.label} = ${l.value}` : l.kind,
  );

describe('ESC/POS', () => {
  it('packs pixels MSB first, dark = 1, transparent = paper', () => {
    // 10 × 1 pixels: black, white, black, transparent black, then six black.
    const px = (r: number, a = 255) => [r, r, r, a];
    const rgba = Uint8ClampedArray.from([
      ...px(0),
      ...px(255),
      ...px(0),
      ...px(0, 0),
      ...[0, 0, 0, 0, 0, 0].flatMap(() => px(0)),
    ]);
    const { bits, widthBytes } = toMonochrome(rgba, 10, 1);
    expect(widthBytes).toBe(2);
    expect([...bits]).toEqual([0b1010_1111, 0b1100_0000]);
  });

  it('a job: reset, drawer kick first, raster blocks of at most 256 rows, feed and cut', () => {
    const height = 300;
    const job = receiptJob({
      bits: new Uint8Array(2 * height).fill(0xaa),
      widthBytes: 2,
      height,
      kickDrawer: true,
    });
    expect([...job.subarray(0, 2)]).toEqual([...INIT]);
    expect([...job.subarray(2, 7)]).toEqual([...DRAWER_KICK]);
    // GS v 0, normal, 2 bytes wide, 256 rows high.
    expect([...job.subarray(7, 15)]).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, 0, 1]);
    const second = 15 + 2 * 256;
    expect([...job.subarray(second, second + 8)]).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, 44, 0]);
    expect([...job.subarray(job.length - 4)]).toEqual([...FEED_AND_CUT]);
    expect(job.length).toBe(2 + 5 + 8 + 512 + 8 + 88 + 4);
    // Without cash, the drawer stays shut.
    const card = receiptJob({
      bits: new Uint8Array(2),
      widthBytes: 2,
      height: 1,
      kickDrawer: false,
    });
    expect([...card.subarray(2, 5)]).toEqual([0x1d, 0x76, 0x30]);
    expect([...drawerKickJob()]).toEqual([...INIT, ...DRAWER_KICK]);
    expect(toBase64(Uint8Array.from([0x1b, 0x40]))).toBe('G0A=');
  });
});

describe('receipt content', () => {
  it('both languages (the default): right to left, every label in Arabic and English', () => {
    const m = receiptModel(receipt(), 'both', t());
    expect(m.dir).toBe('rtl');
    const all = texts(m.lines);
    expect(all).toContain('فاتورة ضريبية مبسطة');
    expect(all).toContain('Simplified Tax Invoice');
    expect(all).toContain('رقم / No. = POS-000124');
    expect(all).toContain('الإجمالي قبل الضريبة / Total excl. VAT = 240.00');
    expect(all).toContain('ضريبة القيمة المضافة 5% / VAT 5% = 12.00');
    expect(all).toContain('الإجمالي / TOTAL = 252.00 AED');
    expect(all).toContain('نقدًا / Cash = 300.00');
    expect(all).toContain('الباقي / Change = 48.00');
    expect(all).toContain('TCCA90-05 · 2 × 126.00 = 252.00');
    expect(all).toContain('عدد القطع / Items = 2');
    expect(all.some((x) => x.includes('COPY'))).toBe(false);
  });

  it('English only reads left to right; Arabic only uses dirhams', () => {
    const en = receiptModel(receipt(), 'en', t());
    expect(en.dir).toBe('ltr');
    expect(texts(en.lines)).toContain('TOTAL = 252.00 AED');
    expect(texts(en.lines)).not.toContain('فاتورة ضريبية مبسطة');
    const ar = receiptModel(receipt(), 'ar', t());
    expect(texts(ar.lines)).toContain('الإجمالي = 252.00 درهم');
    expect(texts(ar.lines)).not.toContain('Simplified Tax Invoice');
  });

  it('a VAT-registered customer: full tax invoice with their name and TRN (0010, 0062)', () => {
    const m = receiptModel(
      receipt({}, { invoiceFormat: 'full', billToName: 'Pool LLC', billToTrn: '100111222333003' }),
      'en',
      t(),
    );
    const all = texts(m.lines);
    expect(all).toContain('Tax Invoice');
    expect(all).toContain('Customer = Pool LLC');
    expect(all).toContain('Customer TRN = 100111222333003');
  });

  it('a card payment shows the approval code only; a reprint is marked as a copy', () => {
    const m = receiptModel(
      receipt({
        printCount: 1,
        changeFils: '0',
        payments: [
          {
            id: '2',
            docNumber: 'RCT-2',
            methodNameAr: 'بطاقة',
            methodNameEn: 'Card',
            methodKind: 'card',
            amountFils: '25200',
            tenderedFils: null,
            changeFils: null,
            reference: 'A1B2C3',
          },
        ],
      }),
      'en',
      t(),
    );
    const all = texts(m.lines);
    expect(all).toContain('Approval code = A1B2C3');
    expect(all).toContain('COPY');
    expect(all.some((x) => x.startsWith('Change'))).toBe(false);
  });
});
