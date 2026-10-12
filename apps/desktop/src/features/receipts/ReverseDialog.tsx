/**
 * Reversing a posted payment (decision 0048): a bounced cheque or an entry error. A reversal
 * (RVS-) undoes it: what it settled is open again, and a payment invoice it created is cancelled
 * by a credit note in the same operation. Refused once a final invoice has deducted that invoice.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PaymentDetail, ReversePaymentRequest } from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import { Alert, Button, Dialog, DialogFooter, InfoBar, SelectField, TextField } from '../../ui';
import { useErrorText } from '../auth/context';
import { ruleOf } from '../inventory/parts';
import { money } from '../masterdata/format';
import { localName, useReasonCodes } from '../masterdata/refs';
import { SALES_INVALIDATE, SALES_KEYS, SALES_PATHS } from '../sales/api';
import { useQueryClient } from '@tanstack/react-query';
import styles from './receipts.module.css';

export function ReverseDialog(props: {
  payment: PaymentDetail;
  onClose: () => void;
  onReversed: (reversal: PaymentDetail) => void;
}) {
  const { t, i18n } = useTranslation('receipts');
  const name = localName(i18n.language);
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const reasonCodes = useReasonCodes();
  const [reasonCodeId, setReasonCodeId] = useState('');
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState<'reason' | 'note' | null>(null);
  const p = props.payment;

  const reasons = (reasonCodes.data ?? []).filter(
    (r) => r.category === 'payment_reversal' && r.isActive,
  );
  const reason = reasons.find((r) => r.id === reasonCodeId);

  const reverse = useSave(
    (api, body: ReversePaymentRequest, key) =>
      api.post<PaymentDetail>(SALES_PATHS.reverse(p.id), body, { idempotencyKey: key }),
    {
      invalidate: SALES_INVALIDATE,
      onSuccess: (result) => {
        queryClient.setQueryData(SALES_KEYS.payment(result.id), result);
        props.onReversed(result);
      },
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    reverse.reset();
    if (!reason) return setProblem('reason');
    if (reason.requiresNote && !notes.trim()) return setProblem('note');
    setProblem(null);
    reverse.mutate({ reasonCodeId: reason.id, ...(notes.trim() ? { notes: notes.trim() } : {}) });
  };

  // A final invoice already deducted the payment invoice this receipt created.
  const deducted = ruleOf(reverse.error) === 'ADVANCE_DEDUCTION';
  return (
    <Dialog isOpen onClose={props.onClose} title={t('reverse.title')}>
      <form onSubmit={submit} noValidate className={styles.form}>
        <div>
          <b>
            <bdi>{p.docNumber}</bdi>
          </b>
          <span className={styles.muted}>
            {' · '}
            {p.customerName}
            {' · '}
            <bdi>{money(BigInt(p.amountFils))}</bdi>
          </span>
        </div>
        <InfoBar>{t('reverse.explain')}</InfoBar>
        <SelectField
          id="reverse-reason"
          label={t('reverse.reason')}
          value={reasonCodeId}
          onChange={setReasonCodeId}
          options={[
            { value: '', label: t('reverse.chooseReason') },
            ...reasons.map((r) => ({ value: r.id, label: name(r) })),
          ]}
        />
        {problem === 'reason' && (
          <span className={styles.fieldError}>{t('reverse.reasonMissing')}</span>
        )}
        <TextField
          label={reason?.requiresNote ? t('reverse.noteRequired') : t('reverse.note')}
          value={notes}
          onChange={setNotes}
          maxLength={1000}
          multiline
          isRequired={reason?.requiresNote ?? false}
          error={problem === 'note' ? t('reverse.noteMissing') : undefined}
        />
        {reverse.error !== null && (
          <Alert>{deducted ? t('reverse.deducted') : errorText(reverse.error)}</Alert>
        )}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('reverse.cancel')}</Button>
          <Button type="submit" variant="danger" busy={reverse.isPending}>
            {t('reverse.confirm')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
