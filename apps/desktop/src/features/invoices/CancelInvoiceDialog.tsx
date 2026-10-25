/**
 * Cancelling or editing an issued A4 invoice (decision 0072). The invoice itself never changes:
 * a credit note for all of it brings the goods back and reverses the VAT, and what the customer
 * paid is refunded now. "Edit" then opens a new draft copied from it. The owner does it, or
 * approves it for someone else.
 */
import { useState, type FormEvent } from 'react';
import { formatFils } from '@artepool/shared';
import { useTranslation } from 'react-i18next';
import type {
  CancelInvoiceRequest,
  CancelInvoiceResponse,
  DocumentDetail,
} from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import { Alert, Button, Dialog, DialogFooter, Note, TextField } from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { ApprovalDialog } from '../masterdata/ApprovalDialog';
import { money } from '../masterdata/format';
import { SALES_INVALIDATE, useSalesPaymentMethods } from '../sales/api';
import { PaymentPartsEditor, newPart, readParts, type PartDraft, type PartProblem } from './parts';
import salesStyles from '../sales/sales.module.css';

export function CancelInvoiceDialog(props: {
  doc: DocumentDetail;
  mode: 'cancel' | 'edit';
  onClose: () => void;
  onDone: (result: CancelInvoiceResponse) => void;
}) {
  const { t } = useTranslation('invoices');
  const can = useCan();
  const errorText = useErrorText();
  const methods = useSalesPaymentMethods();
  const { doc, mode } = props;
  const paid = BigInt(doc.settledFils);
  const [reason, setReason] = useState('');
  const [parts, setParts] = useState<PartDraft[] | null>(null);
  const [partProblems, setPartProblems] = useState<Record<number, PartProblem>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [approving, setApproving] = useState<CancelInvoiceRequest | null>(null);
  // The paid amount goes back in cash by default; the person can change the way or split it.
  const cashMethod = (methods.data ?? []).find((m) => m.kind === 'cash');
  const shownParts =
    parts ?? (paid > 0n && cashMethod ? [newPart(cashMethod.id, formatFils(paid))] : []);

  const cancel = useSave(
    (api, body: CancelInvoiceRequest, key) =>
      api.post<CancelInvoiceResponse>(`/api/v1/sales/documents/${doc.id}/cancel`, body, {
        idempotencyKey: key,
      }),
    { invalidate: SALES_INVALIDATE, onSuccess: (result) => props.onDone(result) },
  );
  const send = (body: CancelInvoiceRequest) =>
    cancel.mutate(body, { onError: (e) => setProblem(errorText(e)) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (reason.trim().length < 3) return setProblem(t('cancel.reasonRequired'));
    let refund: CancelInvoiceRequest['refund'];
    if (paid > 0n) {
      const read = readParts(shownParts, methods.data ?? []);
      if (!read.ok) return setPartProblems(read.problems);
      setPartProblems({});
      if (read.totalFils !== paid)
        return setProblem(t('cancel.refundAll', { amount: money(paid) }));
      refund = read.value;
    }
    const body: CancelInvoiceRequest = {
      mode,
      reason: reason.trim(),
      rowVersion: doc.rowVersion,
      ...(refund ? { refund } : {}),
    };
    // Only the owner cancels; anyone else asks the owner to approve it.
    if (!can('invoices.cancel')) return setApproving(body);
    send(body);
  };

  return (
    <>
      <Dialog
        isOpen
        wide
        onClose={props.onClose}
        title={mode === 'edit' ? t('cancel.editTitle') : t('cancel.cancelTitle')}
      >
        <form onSubmit={submit} noValidate className={salesStyles.form}>
          <Note>
            {t(mode === 'edit' ? 'cancel.editHelp' : 'cancel.cancelHelp', {
              number: doc.docNumber ?? '',
            })}
          </Note>
          <TextField label={t('cancel.reason')} value={reason} onChange={setReason} autoFocus />
          {paid > 0n && (
            <>
              <p>{t('cancel.refundHelp', { amount: money(paid) })}</p>
              <PaymentPartsEditor
                parts={shownParts}
                onChange={setParts}
                methods={methods.data ?? []}
                problems={partProblems}
              />
            </>
          )}
          {!can('invoices.cancel') && <Alert tone="warn">{t('cancel.ownerApproves')}</Alert>}
          {problem && <Alert>{problem}</Alert>}
          <DialogFooter>
            <Button onPress={props.onClose}>{t('form.keep')}</Button>
            <Button type="submit" variant="danger" busy={cancel.isPending}>
              {mode === 'edit' ? t('cancel.editConfirm') : t('cancel.cancelConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      {approving && (
        <ApprovalDialog
          permission="invoices.cancel"
          title={t('cancel.approvalTitle')}
          explanation={t('cancel.ownerApproves')}
          subject={
            <>
              <b>{doc.billToName}</b> · <bdi>{doc.docNumber}</bdi>
            </>
          }
          context={{ action: mode, documentId: doc.id }}
          onClose={() => setApproving(null)}
          onApproved={(approvalId) => {
            const body = { ...approving, approvalId };
            setApproving(null);
            send(body);
          }}
        />
      )}
    </>
  );
}
