/**
 * A return at the POS (decision 0060): find the POS invoice by its number, choose what comes back
 * and where it goes (sellable or defective), give the reason; a supervisor approves. The server
 * makes a credit note linked to the invoice (which never changes), brings the stock back and pays
 * the money back from the shift open now — card payments back to the card.
 */
import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatQuantity, parseQuantity } from '@artepool/shared';
import type {
  DocumentDetail,
  DocumentsResponse,
  PosReturnResponse,
  PosState,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../api/hooks';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  iconClass,
  Note,
  SelectField,
  TextField,
} from '../../ui';
import { useErrorText } from '../auth/context';
import { ApprovalDialog } from '../masterdata/ApprovalDialog';
import { money } from '../masterdata/format';
import { localName, useReasonCodes } from '../masterdata/refs';
import { POS_INVALIDATE, POS_PATHS } from './api';
import { printReceipt, type PrintOutcome } from './receipt/printer';
import styles from './pos.module.css';

const trimQty = (milli: string) => formatQuantity(BigInt(milli)).replace(/\.?0+$/, '');
const readMilli = (text: string): bigint | null => {
  try {
    return text.trim() === '' ? 0n : parseQuantity(text.trim());
  } catch {
    return null;
  }
};

export function ReturnDialog(props: { state: PosState; onClose: () => void }) {
  const { t, i18n } = useTranslation('pos');
  const api = useApi();
  const errorText = useErrorText();
  const name = localName(i18n.language);
  const reasons = (useReasonCodes().data ?? []).filter(
    (r) => r.category === 'credit_note' && r.isActive,
  );
  const [number, setNumber] = useState('');
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [defective, setDefective] = useState<Record<string, boolean>>({});
  const [reasonId, setReasonId] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [finished, setFinished] = useState<{
    result: PosReturnResponse;
    print: PrintOutcome;
    image: string;
  } | null>(null);

  const find = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setDoc(null);
    try {
      const list = await api.get<DocumentsResponse>(
        `/api/v1/sales/documents?${new URLSearchParams({ q: number.trim(), docType: 'invoice', status: 'issued', pageSize: '5' }).toString()}`,
      );
      const hit = list.documents.find(
        (d) => d.docNumber?.toLowerCase() === number.trim().toLowerCase(),
      );
      if (!hit) return setProblem(t('returns.notFound'));
      if (hit.channel !== 'pos') return setProblem(t('returns.notPos'));
      setDoc(await api.get<DocumentDetail>(`/api/v1/sales/documents/${hit.id}`));
      setQuantities({});
    } catch (e) {
      setProblem(errorText(e));
    }
  };

  const lines = (doc?.lines ?? []).filter((l) => l.lineKind === 'item');
  const chosen = lines.flatMap((l) => {
    const q = readMilli(quantities[l.id] ?? '');
    return q !== null && q > 0n
      ? [
          {
            originalLineId: l.id,
            quantityMilli: q.toString(),
            returnStockStatus: defective[l.id] ? ('defective' as const) : ('available' as const),
            max: BigInt(l.quantityMilli),
          },
        ]
      : [];
  });
  const invalid =
    lines.some((l) => readMilli(quantities[l.id] ?? '') === null) ||
    chosen.some((c) => BigInt(c.quantityMilli) > c.max);

  const send = useSave(
    (client, approvalId: string, key) =>
      client.post<PosReturnResponse>(
        POS_PATHS.returns,
        {
          originalDocumentId: doc!.id,
          reasonCodeId: reasonId,
          reasonText: reasonText.trim(),
          lines: chosen.map(({ max: _max, ...c }) => c),
          approvalId,
        },
        { idempotencyKey: key },
      ),
    {
      invalidate: POS_INVALIDATE,
      onSuccess: (result) => void showDone(result),
    },
  );

  const showDone = async (result: PosReturnResponse) => {
    const printed = await printReceipt(result.receipt, {
      language: props.state.receiptLanguage,
      i18n,
      kickDrawer: result.opensDrawer,
    });
    setFinished({ result, print: printed.outcome, image: printed.imageUrl });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (chosen.length === 0 || invalid) return setProblem(t('returns.chooseLines'));
    if (!reasonId || reasonText.trim().length < 3) return setProblem(t('returns.reasonRequired'));
    setApproving(true);
  };

  if (finished) {
    const refunds = finished.result.refunds;
    return (
      <Dialog isOpen onClose={props.onClose} title={t('returns.doneTitle')}>
        <p>
          {t('returns.creditNote')}{' '}
          <b>
            <bdi>{finished.result.creditNote.docNumber}</bdi>
          </b>
        </p>
        {refunds.map((r) => (
          <p key={r.id}>
            {i18n.language === 'en' ? r.methodNameEn : r.methodNameAr}:{' '}
            <b>
              <bdi>{money(BigInt(r.amountFils))}</bdi>
            </b>
          </p>
        ))}
        {finished.result.opensDrawer && <Note>{t('returns.payFromDrawer')}</Note>}
        {!finished.print.printed && (
          <>
            <Alert tone="warn">{t(`done.notPrinted.${finished.print.reason}`)}</Alert>
            <img className={styles.preview} src={finished.image} alt={t('done.preview')} />
          </>
        )}
        <DialogFooter>
          <Button variant="primary" onPress={props.onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <>
      <Dialog isOpen onClose={props.onClose} title={t('returns.title')}>
        <form onSubmit={(e) => void find(e)} className={styles.findRow} noValidate>
          <TextField
            label={t('returns.invoiceNumber')}
            value={number}
            onChange={setNumber}
            ltr
            autoFocus
            placeholder={t('returns.numberHint')}
          />
          <Button type="submit">
            <Search className={iconClass.sm} aria-hidden="true" />
            {t('returns.find')}
          </Button>
        </form>
        {doc && (
          <form onSubmit={submit} noValidate className={styles.payForm}>
            <Note>
              {t('returns.invoiceOf', {
                customer: doc.billToName,
                total: money(BigInt(doc.totalFils)),
              })}
            </Note>
            <table className={styles.returnTable}>
              <thead>
                <tr>
                  <th>{t('returns.item')}</th>
                  <th>{t('returns.sold')}</th>
                  <th>{t('returns.back')}</th>
                  <th>{t('returns.defective')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {name({ nameAr: l.descriptionAr, nameEn: l.descriptionEn })}{' '}
                      <span className={styles.muted}>
                        <bdi>{l.itemCode}</bdi>
                      </span>
                    </td>
                    <td>
                      <bdi>{trimQty(l.quantityMilli)}</bdi>
                    </td>
                    <td>
                      <input
                        className={styles.qtyInput}
                        aria-label={t('returns.backOf', { item: l.itemCode ?? '' })}
                        inputMode="decimal"
                        value={quantities[l.id] ?? ''}
                        onChange={(e) => setQuantities({ ...quantities, [l.id]: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t('returns.defectiveOf', { item: l.itemCode ?? '' })}
                        checked={defective[l.id] ?? false}
                        onChange={(e) => setDefective({ ...defective, [l.id]: e.target.checked })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <SelectField
              id="return-reason"
              label={t('returns.reason')}
              value={reasonId}
              onChange={setReasonId}
              options={[
                { value: '', label: t('returns.chooseReason') },
                ...reasons.map((r) => ({ value: r.id, label: name(r) })),
              ]}
            />
            <TextField
              label={t('returns.reasonText')}
              value={reasonText}
              onChange={setReasonText}
            />
            <Note>{t('returns.needsSupervisor')}</Note>
            {(problem ?? (send.error !== null ? errorText(send.error) : null)) && (
              <Alert>{problem ?? errorText(send.error)}</Alert>
            )}
            <DialogFooter>
              <Button onPress={props.onClose}>{t('cancel')}</Button>
              <Button type="submit" variant="primary" busy={send.isPending}>
                {t('returns.confirm')}
              </Button>
            </DialogFooter>
          </form>
        )}
        {!doc && problem && <Alert>{problem}</Alert>}
      </Dialog>
      {approving && (
        <ApprovalDialog
          permission="credit_notes.issue"
          title={t('approval.credit_notes.issue.title')}
          explanation={t('approval.credit_notes.issue.explain')}
          onClose={() => setApproving(false)}
          onApproved={(id) => {
            setApproving(false);
            send.mutate(id);
          }}
        />
      )}
    </>
  );
}
