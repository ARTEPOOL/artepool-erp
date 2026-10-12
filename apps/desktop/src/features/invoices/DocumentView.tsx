/**
 * An issued (or discarded) document, read-only: the header with the customer as printed, the
 * lines with VAT per line (decision 0009), earlier payments deducted (0013), the server's totals,
 * what settled it and what is still due. From here: print or reprint (0008), a credit or debit
 * note, and receiving a payment (in the Receipts section).
 */
import { useState, type ReactNode } from 'react';
import { FileMinus, FilePlus, Printer, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from '@tanstack/react-router';
import { formatQuantity } from '@artepool/shared';
import type { DocumentDetail, SalesLine } from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import { formatDate, formatDateTime } from '../../lib/format';
import {
  Button,
  Card,
  CardHeader,
  cx,
  DefinitionList,
  EmptyState,
  iconClass,
  tableClasses as tbl,
  useToast,
} from '../../ui';
import { useCan, useDisplayName } from '../auth/context';
import { SaveError } from '../inventory/parts';
import { money, price, rate } from '../masterdata/format';
import { fetchPdf, SALES_KEYS, SALES_PATHS } from '../sales/api';
import { TotalsBox } from '../sales/LineEditor';
import { printPdf } from '../sales/print';
import salesStyles from '../sales/sales.module.css';
import { NoteDialog } from './NoteDialog';
import { FormatChip, SettlementChip, StatusChip } from './parts';
import styles from './invoices.module.css';

const qty = (milli: string) => formatQuantity(BigInt(milli)).replace(/\.?0+$/, '') || '0';

/** Print, or reprint ("Copy"): the server makes the PDF; the print dialog chooses the printer. */
export function PrintButton({ doc }: { doc: DocumentDetail }) {
  const { t } = useTranslation('invoices');
  const can = useCan();
  const toast = useToast();
  const issued = doc.status === 'issued';
  const reprint = issued && doc.printCount > 0;
  const print = useSave(
    async (a, _input: { id: string; count: number }, key) => {
      const file = await fetchPdf(a, SALES_PATHS.documentPdf(doc.id));
      await printPdf(file);
      // Only issued documents are counted; a draft prints marked DRAFT.
      if (issued) await a.post(SALES_PATHS.documentPrinted(doc.id), {}, { idempotencyKey: key });
    },
    {
      invalidate: issued ? [SALES_KEYS.all] : [],
      onSuccess: () => toast(t('print.sent')),
    },
  );
  const blocked = reprint && !can('documents.reprint');
  return (
    <>
      <Button
        busy={print.isPending}
        isDisabled={blocked}
        onPress={() => print.mutate({ id: doc.id, count: doc.printCount })}
      >
        <Printer className={iconClass.sm} aria-hidden="true" />
        {print.isPending
          ? t('sales:print.preparing')
          : reprint
            ? t('sales:print.reprint')
            : t('sales:print.print')}
      </Button>
      {blocked && <span className={salesStyles.muted}>{t('print.noReprint')}</span>}
      {print.error !== null && <SaveError error={print.error} />}
    </>
  );
}

function LinesTable({ doc }: { doc: DocumentDetail }) {
  const { t, i18n } = useTranslation('invoices');
  const description = (l: SalesLine) =>
    i18n.language === 'en' ? l.descriptionEn : l.descriptionAr;
  return (
    <div className={salesStyles.tableWrap}>
      <table className={tbl.table} aria-label={t('sales:lines.title')}>
        <thead>
          <tr>
            <th>{t('sales:lines.description')}</th>
            <th className={tbl.num}>{t('sales:lines.quantity')}</th>
            <th className={tbl.num}>{t('sales:lines.unitPrice')}</th>
            <th className={tbl.num}>{t('sales:lines.discount')}</th>
            <th className={tbl.num}>{t('sales:lines.net')}</th>
            <th className={tbl.num}>{t('sales:lines.vatRate')}</th>
            <th className={tbl.num}>{t('sales:lines.vat')}</th>
            <th className={tbl.num}>{t('sales:lines.lineTotal')}</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l) => {
            if (l.lineKind === 'advance_deduction') {
              return (
                <tr key={l.id} className={styles.deductionRow}>
                  <td colSpan={4}>
                    <span>{t('sales:lines.deduction')}</span>
                    <span className={tbl.sub}>
                      {l.advanceDocumentNumber && <bdi>{l.advanceDocumentNumber}</bdi>}
                    </span>
                  </td>
                  <td className={tbl.num}>
                    <bdi>{money(BigInt(l.netFils))}</bdi>
                  </td>
                  <td className={tbl.num}>
                    <bdi>{rate(l.vatRateBp)}</bdi>
                  </td>
                  <td className={tbl.num}>
                    <bdi>{money(BigInt(l.vatFils))}</bdi>
                  </td>
                  <td className={tbl.num}>
                    <bdi>{money(BigInt(l.grossFils))}</bdi>
                  </td>
                </tr>
              );
            }
            const discount = BigInt(l.lineDiscountFils) + BigInt(l.docDiscountAllocFils);
            return (
              <tr key={l.id}>
                <td>
                  <span>{description(l)}</span>
                  <span className={tbl.sub}>
                    {l.itemCode && <bdi>{l.itemCode}</bdi>}
                    {l.returnStockStatus && <> · {t(`notes.back.${l.returnStockStatus}`)}</>}
                  </span>
                </td>
                <td className={tbl.num}>
                  <bdi>{l.lineKind === 'item' ? qty(l.quantityMilli) : '—'}</bdi>
                </td>
                <td className={tbl.num}>
                  <bdi>{price(BigInt(l.unitPrice4dp))}</bdi>
                  {l.priceIncludesVat && <span className={tbl.sub}>{t('view.inclVat')}</span>}
                </td>
                <td className={tbl.num}>
                  <bdi>{discount > 0n ? money(discount) : '—'}</bdi>
                </td>
                <td className={tbl.num}>
                  <bdi>{money(BigInt(l.netFils))}</bdi>
                </td>
                <td className={tbl.num}>
                  <bdi>{rate(l.vatRateBp)}</bdi>
                </td>
                <td className={tbl.num}>
                  <bdi>{money(BigInt(l.vatFils))}</bdi>
                </td>
                <td className={tbl.num}>
                  <bdi>{money(BigInt(l.grossFils))}</bdi>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The server's totals; with deductions, the total before them and the payments deducted. */
function DocumentTotals({ doc }: { doc: DocumentDetail }) {
  const { t } = useTranslation('invoices');
  const deductions = doc.lines.filter((l) => l.lineKind === 'advance_deduction');
  const items = doc.lines.filter((l) => l.lineKind !== 'advance_deduction');
  const sum = (lines: SalesLine[], pick: (l: SalesLine) => string) =>
    lines.reduce((s, l) => s + BigInt(pick(l)), 0n);
  const discount = BigInt(doc.discountTotalFils);
  const rows: { label: string; fils: bigint; strong?: boolean }[] = [];
  if (discount > 0n) rows.push({ label: t('sales:totals.discount'), fils: discount });
  if (deductions.length === 0) {
    rows.push(
      { label: t('sales:totals.net'), fils: BigInt(doc.netFils) },
      { label: t('sales:totals.vat'), fils: BigInt(doc.vatFils) },
      { label: t('sales:totals.total'), fils: BigInt(doc.totalFils), strong: true },
    );
  } else {
    rows.push(
      { label: t('sales:totals.net'), fils: sum(items, (l) => l.netFils) },
      { label: t('sales:totals.vat'), fils: sum(items, (l) => l.vatFils) },
      { label: t('view.beforeDeductions'), fils: sum(items, (l) => l.grossFils) },
      { label: t('sales:totals.deductions'), fils: sum(deductions, (l) => l.grossFils) },
      { label: t('view.vatAfterDeductions'), fils: BigInt(doc.vatFils) },
      { label: t('sales:totals.due'), fils: BigInt(doc.totalFils), strong: true },
    );
  }
  return <TotalsBox rows={rows} />;
}

function Settlements({ doc }: { doc: DocumentDetail }) {
  const { t } = useTranslation('invoices');
  const total = BigInt(doc.totalFils);
  const settled = BigInt(doc.settledFils);
  return (
    <Card rise index={4} padding="table">
      <CardHeader title={t('view.settlements')} />
      {doc.settlements.length === 0 ? (
        <EmptyState>{t('view.noSettlements')}</EmptyState>
      ) : (
        <table className={tbl.table} aria-label={t('view.settlements')}>
          <thead>
            <tr>
              <th>{t('sales:fields.number')}</th>
              <th>{t('sales:fields.date')}</th>
              <th className={tbl.num}>{t('sales:fields.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {doc.settlements.map((s) => (
              <tr key={`${s.kind}-${s.id}`}>
                <td>
                  {s.kind === 'credit_note' ? (
                    <Link
                      to="/invoices/$documentId"
                      params={{ documentId: s.id }}
                      className={styles.link}
                    >
                      <bdi>{s.docNumber}</bdi>
                    </Link>
                  ) : (
                    <Link
                      to="/receipts/$paymentId"
                      params={{ paymentId: s.id }}
                      className={styles.link}
                    >
                      <bdi>{s.docNumber}</bdi>
                    </Link>
                  )}
                  <span className={tbl.sub}>{t(`view.settlementKinds.${s.kind}`)}</span>
                </td>
                <td>{s.date ? <bdi>{formatDate(s.date)}</bdi> : '—'}</td>
                <td className={tbl.num}>
                  <bdi>{money(BigInt(s.amountFils))}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className={salesStyles.cardBody}>
        <TotalsBox
          rows={[
            { label: t('sales:fields.paid'), fils: settled },
            { label: t('sales:fields.due'), fils: total - settled, strong: true },
          ]}
        />
      </div>
    </Card>
  );
}

export function DocumentView({ doc }: { doc: DocumentDetail }) {
  const { t } = useTranslation('invoices');
  const can = useCan();
  const nameOf = useDisplayName();
  const navigate = useNavigate();
  const toast = useToast();
  const [note, setNote] = useState<'credit_note' | 'debit_note' | null>(null);
  const issued = doc.status === 'issued';
  const dueFils = BigInt(doc.totalFils) - BigInt(doc.settledFils);
  const isInvoice = doc.docType === 'invoice';
  const isAdvance = doc.docType === 'advance_invoice';
  const advanceLeft = BigInt(doc.advanceLeftNetFils ?? '0') + BigInt(doc.advanceLeftVatFils ?? '0');
  const canCredit =
    issued && can('invoices.create') && (isInvoice || (isAdvance && advanceLeft > 0n));
  const canDebit = issued && isInvoice && can('invoices.create') && can('invoices.issue');
  const canReceive =
    issued &&
    can('payments.receive') &&
    (isInvoice || doc.docType === 'debit_note') &&
    dueFils > 0n;

  const rows: { label: string; value: ReactNode }[] = [
    { label: t('view.type'), value: t(`sales:docTypes.${doc.docType}`) },
    { label: t('view.format'), value: <FormatChip format={doc.invoiceFormat} /> },
    {
      label: t('sales:fields.status'),
      value: (
        <span className={styles.chips}>
          <StatusChip status={doc.status} />
          {issued && <SettlementChip status={doc.settlementStatus} />}
        </span>
      ),
    },
  ];
  if (doc.issueDate)
    rows.push({
      label: t('sales:fields.issueDate'),
      value: <bdi>{formatDate(doc.issueDate)}</bdi>,
    });
  if (doc.supplyDate)
    rows.push({ label: t('view.supplyDate'), value: <bdi>{formatDate(doc.supplyDate)}</bdi> });
  if (doc.dueDate)
    rows.push({ label: t('sales:fields.dueDate'), value: <bdi>{formatDate(doc.dueDate)}</bdi> });
  if (doc.originalDocumentId)
    rows.push({
      label: t('view.original'),
      value: (
        <Link
          to="/invoices/$documentId"
          params={{ documentId: doc.originalDocumentId }}
          className={styles.link}
        >
          <bdi>{doc.originalDocumentNumber ?? doc.originalDocumentId}</bdi>
        </Link>
      ),
    });
  if (doc.reasonText) rows.push({ label: t('view.reason'), value: doc.reasonText });
  if (doc.issuedAt)
    rows.push({
      label: t('view.issuedBy'),
      value: (
        <>
          {doc.issuedByName ? nameOf(doc.issuedByName) : ''}{' '}
          <bdi className={salesStyles.muted}>{formatDateTime(doc.issuedAt)}</bdi>
        </>
      ),
    });

  const customerRows: { label: string; value: ReactNode }[] = [
    {
      label: t('view.billTo'),
      value: (
        <>
          {doc.billToName}
          {doc.billToNameAlt && <span className={tbl.sub}>{doc.billToNameAlt}</span>}
        </>
      ),
    },
  ];
  if (doc.invoiceFormat === 'full' && doc.billToTrn)
    customerRows.push({ label: t('view.trn'), value: <bdi>{doc.billToTrn}</bdi> });
  if (doc.billToPhone)
    customerRows.push({ label: t('view.phone'), value: <bdi>{doc.billToPhone}</bdi> });
  if (doc.billToAddress) customerRows.push({ label: t('view.address'), value: doc.billToAddress });
  if (doc.notes) customerRows.push({ label: t('sales:fields.notes'), value: doc.notes });

  return (
    <>
      <Card rise index={1}>
        <div className={cx(salesStyles.cardBody, styles.columns)}>
          <DefinitionList rows={rows} />
          <DefinitionList rows={customerRows} />
        </div>
      </Card>

      <Card rise index={2} padding="table">
        <CardHeader title={t('sales:lines.title')} />
        <div className={salesStyles.cardBody}>
          <LinesTable doc={doc} />
          <DocumentTotals doc={doc} />
        </div>
      </Card>

      {issued && <Settlements doc={doc} />}

      <Card rise index={5}>
        <div className={salesStyles.cardBody}>
          {doc.status !== 'discarded' && (
            <p className={salesStyles.muted}>{t('sales:print.copyNote')}</p>
          )}
          <div className={salesStyles.actions}>
            {canReceive && (
              <Button
                onPress={() =>
                  void navigate({
                    to: '/receipts/$paymentId',
                    params: { paymentId: 'new' },
                    search: { customerId: doc.customerId },
                  })
                }
              >
                <Wallet className={iconClass.sm} aria-hidden="true" />
                {t('view.receive')}
              </Button>
            )}
            {canDebit && (
              <Button onPress={() => setNote('debit_note')}>
                <FilePlus className={iconClass.sm} aria-hidden="true" />
                {t('notes.debitButton')}
              </Button>
            )}
            {canCredit && (
              <Button onPress={() => setNote('credit_note')}>
                <FileMinus className={iconClass.sm} aria-hidden="true" />
                {t('notes.creditButton')}
              </Button>
            )}
            {doc.status !== 'discarded' && <PrintButton doc={doc} />}
          </div>
        </div>
      </Card>

      {note && (
        <NoteDialog
          kind={note}
          original={doc}
          onClose={() => setNote(null)}
          onCreated={(created) => {
            setNote(null);
            toast(t('notes.done', { number: created.docNumber ?? '' }));
            void navigate({ to: '/invoices/$documentId', params: { documentId: created.id } });
          }}
        />
      )}
    </>
  );
}
