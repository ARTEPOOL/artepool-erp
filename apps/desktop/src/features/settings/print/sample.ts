/**
 * A sample thermal receipt for the print designer's live preview (decision 0064): the company's
 * own details, a few typical lines, a cash payment. Never sent to the server.
 */
import type {
  CompanyProfile,
  DocumentDetail,
  ReceiptData,
  SalesLine,
  TemplateSettings,
} from '@artepool/shared/contracts';

const line = (
  code: string,
  ar: string,
  en: string,
  qty: string,
  price4dp: string,
  net: string,
  vat: string,
): SalesLine =>
  ({
    id: code,
    lineNo: 1,
    lineKind: 'item',
    itemId: '1',
    itemCode: code,
    descriptionAr: ar,
    descriptionEn: en,
    quantityMilli: qty,
    unitPrice4dp: price4dp,
    priceIncludesVat: true,
    lineDiscountFils: '0',
    docDiscountAllocFils: '0',
    netFils: net,
    vatCategoryId: '1',
    vatRateBp: 500,
    vatFils: vat,
    grossFils: (BigInt(net) + BigInt(vat)).toString(),
  }) as SalesLine;

export function sampleReceipt(
  company: CompanyProfile | null,
  template: TemplateSettings,
  full: boolean,
): ReceiptData {
  const lines = [
    line(
      'TCCA90-05',
      'كلور أقراص 90% · 5 كجم',
      'TCCA 90% tablets · 5 kg',
      '2000',
      '1260000',
      '24000',
      '1200',
    ),
    line('ALG-1L', 'مبيد طحالب · 1 لتر', 'Algaecide · 1 L', '1000', '630000', '6000', '300'),
  ];
  return {
    seller: {
      nameAr: company?.tradeNameAr ?? company?.legalNameAr ?? 'ARTÉPOOL',
      nameEn: company?.tradeNameEn ?? company?.legalNameEn ?? 'ARTÉPOOL',
      addressAr: company?.addressAr ?? '',
      addressEn: company?.addressEn ?? '',
      trn: company?.trn ?? null,
      phone: company?.phone ?? null,
      email: company?.email ?? null,
    },
    document: {
      id: '0',
      docType: 'invoice',
      invoiceFormat: full ? 'full' : 'simplified',
      docNumber: 'POS-2026-000124',
      issuedAt: '2026-10-07T10:32:00Z',
      billToName: full ? 'Green Garden Contracting LLC' : 'Cash customer',
      billToTrn: full ? '100234567800003' : null,
      billToAddress: full ? 'Industrial Area, Al Ain' : null,
      billToPhone: full ? '+971 50 123 4567' : null,
      originalDocumentNumber: null,
      discountTotalFils: '0',
      netFils: '30000',
      vatFils: '1500',
      totalFils: '31500',
      lines,
    } as unknown as DocumentDetail,
    payments: [
      {
        id: '1',
        docNumber: 'RCT-1',
        methodNameAr: 'نقدًا',
        methodNameEn: 'Cash',
        methodKind: 'cash',
        amountFils: '31500',
        tenderedFils: '40000',
        changeFils: '8500',
        reference: null,
      },
    ],
    changeFils: '8500',
    cashierName: { displayNameAr: 'أحمد حسن', displayNameEn: 'Ahmed Hassan' },
    shiftNumber: 'Z-000031',
    deviceCode: 'POS-01',
    printCount: 0,
    markCopies: true,
    template,
  };
}
