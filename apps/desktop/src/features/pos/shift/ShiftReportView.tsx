/**
 * The X report (open shift) or the Z report (closed shift): sales, returns, money by method, the
 * cash movements, No Sale count, and — once counted — expected, counted (both counts when there
 * was a recount) and the over/short. The Z report prints on the receipt printer too.
 */
import { Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ShiftReport } from '@artepool/shared/contracts';
import { formatDateTime } from '../../../lib/format';
import { Button, Card, CardHeader, iconClass, Note } from '../../../ui';
import { useDisplayName } from '../../auth/context';
import { money } from '../../masterdata/format';
import { localName } from '../../masterdata/refs';
import { renderReceipt } from '../receipt/render';
import { receiptJob } from '../receipt/escpos';
import { sendJob } from '../receipt/printer';
import type { ReceiptLine } from '../receipt/layout';
import styles from '../pos.module.css';

const m = (fils: string | null) => (fils === null ? '—' : money(BigInt(fils)));

export function ShiftReportView({
  report,
  printable = false,
}: {
  report: ShiftReport;
  printable?: boolean;
}) {
  const { t, i18n } = useTranslation('pos');
  const nameOf = useDisplayName();
  const name = localName(i18n.language);
  const closed = report.shift.status === 'closed';
  const rows: [string, string][] = [
    [t('report.cashier'), nameOf(report.shift.cashierName)],
    [t('report.opened'), formatDateTime(report.shift.openedAt)],
    ...(report.shift.closedAt
      ? [[t('report.closed'), formatDateTime(report.shift.closedAt)] as [string, string]]
      : []),
    [t('report.float'), m(report.shift.openingFloatFils)],
    [t('report.sales', { count: report.salesCount }), m(report.grossSalesFils)],
    [t('report.a4Invoices', { count: report.a4InvoicesCount }), m(report.a4InvoicesFils)],
    [t('report.totalSales'), m(report.totalSalesFils)],
    [t('report.vat'), m(report.vatFils)],
    [t('report.discount'), m(report.discountFils)],
    [t('report.returns', { count: report.returnsCount }), m(report.returnsFils)],
    ...report.byMethod.flatMap((b) => [
      [t('report.received', { method: name(b) }), m(b.receivedFils)] as [string, string],
      ...(BigInt(b.refundedFils) > 0n
        ? [[t('report.refunded', { method: name(b) }), m(b.refundedFils)] as [string, string]]
        : []),
    ]),
    ...report.movements.map(
      (mv) =>
        [
          `${t(`movement.${mv.movementType}`)} · ${mv.voucherNumber}`,
          `${mv.direction === 'out' ? '-' : ''}${m(mv.amountFils)}`,
        ] as [string, string],
    ),
    [t('report.noSales'), String(report.noSaleCount)],
    ...report.counts.map(
      (c) =>
        [c.isRecount ? t('report.recount') : t('report.count'), m(c.totalFils)] as [string, string],
    ),
    [
      t('report.expected'),
      report.expectedCashFils === null ? t('report.hiddenUntilCount') : m(report.expectedCashFils),
    ],
    ...(report.countedCashFils !== null
      ? [[t('report.counted'), m(report.countedCashFils)] as [string, string]]
      : []),
    ...(report.varianceFils !== null
      ? [[t('report.variance'), m(report.varianceFils)] as [string, string]]
      : []),
  ];

  const print = async () => {
    const lines: ReceiptLine[] = [
      {
        kind: 'text',
        text: `${closed ? t('report.zTitle') : t('report.xTitle')} · ${report.shift.shiftNumber}`,
        align: 'center',
        size: 'm',
        bold: true,
      },
      { kind: 'rule' },
      ...rows.map(([label, value]) => ({ kind: 'pair' as const, label, value })),
      { kind: 'rule', heavy: true },
    ];
    const image = renderReceipt({ dir: i18n.language === 'en' ? 'ltr' : 'rtl', lines });
    await sendJob(receiptJob({ ...image, kickDrawer: false }), report.shift.shiftNumber);
  };

  return (
    <Card>
      <CardHeader
        title={`${closed ? t('report.zTitle') : t('report.xTitle')} · ${report.shift.shiftNumber}`}
      >
        {printable && (
          <Button onPress={() => void print()}>
            <Printer className={iconClass.sm} aria-hidden="true" />
            {t('report.print')}
          </Button>
        )}
      </CardHeader>
      <dl className={styles.report} data-testid="shift-report">
        {rows.map(([label, value], i) => (
          <div key={i} className={styles.reportRow}>
            <dt>{label}</dt>
            <dd>
              <bdi>{value}</bdi>
            </dd>
          </div>
        ))}
      </dl>
      {report.acceptance && (
        <Note>
          {t('report.accepted', {
            name: nameOf(report.acceptance.acceptedBy),
            date: formatDateTime(report.acceptance.acceptedAt),
          })}
        </Note>
      )}
    </Card>
  );
}
