/**
 * A customer's statement of account for any dates: the opening balance, every document and
 * payment with the running balance, and the closing balance. Printed as an A4 PDF (decision 0008).
 */
import { useState } from 'react';
import { Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../../api/hooks';
import { dubaiDay, formatDate } from '../../lib/format';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  EmptyState,
  iconClass,
  tableClasses as tbl,
} from '../../ui';
import { useErrorText } from '../auth/context';
import { money } from '../masterdata/format';
import { fetchPdf, SALES_PATHS, useStatement } from '../sales/api';
import { printPdf } from '../sales/print';
import { useKindText } from './parts';
import styles from './receipts.module.css';

const amount = (fils: string) => (BigInt(fils) === 0n ? '' : money(BigInt(fils)));

export function StatementDialog(props: {
  customer: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation('receipts');
  const api = useApi();
  const errorText = useErrorText();
  const kindText = useKindText();
  const today = dubaiDay();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<unknown>(null);
  const datesOk = from !== '' && to !== '' && from <= to;
  const statement = useStatement(datesOk ? props.customer.id : null, from, to);
  const s = statement.data;

  const print = async () => {
    setPrinting(true);
    setPrintError(null);
    try {
      const query = new URLSearchParams({ from, to }).toString();
      await printPdf(await fetchPdf(api, `${SALES_PATHS.statementPdf(props.customer.id)}?${query}`));
    } catch (error) {
      setPrintError(error);
    } finally {
      setPrinting(false);
    }
  };

  return (
    <Dialog isOpen wide onClose={props.onClose} title={t('statement.title')}>
      <div className={styles.form}>
        <b>{props.customer.name}</b>
        <div className={styles.fields}>
          <label className={styles.dateField}>
            <span>{t('statement.from')}</span>
            <input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className={styles.dateField}>
            <span>{t('statement.to')}</span>
            <input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        {!datesOk && <Alert>{t('statement.badDates')}</Alert>}
        {statement.isError && <Alert>{errorText(statement.error)}</Alert>}
        {s && (
          <div className={styles.tableWrap}>
            <table className={tbl.table} aria-label={t('statement.title')}>
              <thead>
                <tr>
                  <th>{t('sales:fields.date')}</th>
                  <th>{t('statement.document')}</th>
                  <th className={tbl.num}>{t('statement.debit')}</th>
                  <th className={tbl.num}>{t('statement.credit')}</th>
                  <th className={tbl.num}>{t('statement.balance')}</th>
                </tr>
              </thead>
              <tbody>
                <tr className={styles.balanceRow}>
                  <td>
                    <bdi>{formatDate(s.from)}</bdi>
                  </td>
                  <td>{t('statement.opening')}</td>
                  <td />
                  <td />
                  <td className={tbl.num}>
                    <bdi>{money(BigInt(s.openingFils))}</bdi>
                  </td>
                </tr>
                {s.lines.map((l) => (
                  <tr key={`${l.kind}-${l.id}`}>
                    <td>
                      <bdi>{formatDate(l.date)}</bdi>
                    </td>
                    <td>
                      {kindText(l.kind)}
                      {l.docNumber && (
                        <>
                          {' '}
                          <bdi className={styles.muted}>{l.docNumber}</bdi>
                        </>
                      )}
                    </td>
                    <td className={tbl.num}>
                      <bdi>{amount(l.debitFils)}</bdi>
                    </td>
                    <td className={tbl.num}>
                      <bdi>{amount(l.creditFils)}</bdi>
                    </td>
                    <td className={tbl.num}>
                      <bdi>{money(BigInt(l.balanceFils))}</bdi>
                    </td>
                  </tr>
                ))}
                <tr className={styles.balanceRow}>
                  <td>
                    <bdi>{formatDate(s.to)}</bdi>
                  </td>
                  <td>{t('statement.closing')}</td>
                  <td />
                  <td />
                  <td className={tbl.num}>
                    <b>
                      <bdi>{money(BigInt(s.closingFils))}</bdi>
                    </b>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {s && s.lines.length === 0 && <EmptyState>{t('statement.empty')}</EmptyState>}
        {statement.isLoading && datesOk && <EmptyState>{t('sales:loading')}</EmptyState>}
        <p className={styles.muted}>{t('statement.sign')}</p>
        {printError !== null && <Alert>{errorText(printError)}</Alert>}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('statement.close')}</Button>
          <Button
            variant="primary"
            busy={printing}
            isDisabled={!datesOk}
            onPress={() => void print()}
          >
            <Printer className={iconClass.sm} aria-hidden="true" />
            {t('sales:print.print')}
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
