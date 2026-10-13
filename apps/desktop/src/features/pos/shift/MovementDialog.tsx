/**
 * Paid-in, paid-out (with a reason, decision 0004), a cash drop to the safe or a float top-up from
 * it. A paid-out by someone without the permission is approved by a supervisor. The drawer opens.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyFormatError, parseFils } from '@artepool/shared';
import type { CashMovementItem, CashMovementType } from '@artepool/shared/contracts';
import { useSave } from '../../../api/hooks';
import { Alert, Button, Dialog, DialogFooter, SelectField, TextField } from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { ApprovalDialog } from '../../masterdata/ApprovalDialog';
import { localName, useReasonCodes } from '../../masterdata/refs';
import { POS_INVALIDATE, POS_PATHS } from '../api';
import { kickDrawer } from '../receipt/printer';
import styles from '../pos.module.css';

export type MovementKind = CashMovementType;

export function MovementDialog(props: { kind: MovementKind; onClose: () => void }) {
  const { t, i18n } = useTranslation('pos');
  const can = useCan();
  const errorText = useErrorText();
  const paid = props.kind === 'paid_in' || props.kind === 'paid_out';
  const reasons = (useReasonCodes().data ?? []).filter(
    (r) => r.category === props.kind && r.isActive,
  );
  const [amount, setAmount] = useState('');
  const [reasonId, setReasonId] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [approving, setApproving] = useState<bigint | null>(null);
  const save = useSave(
    (api, body: Record<string, unknown>, key) =>
      api.post<{ movement: CashMovementItem; dropDue: boolean }>(POS_PATHS.movements, body, {
        idempotencyKey: key,
      }),
    {
      invalidate: POS_INVALIDATE,
      onSuccess: () => {
        void kickDrawer();
        props.onClose();
      },
    },
  );
  const send = (fils: bigint, approvalId?: string) =>
    save.mutate(
      {
        movementType: props.kind,
        amountFils: fils.toString(),
        ...(paid ? { reasonCodeId: reasonId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(approvalId ? { approvalId } : {}),
      },
      { onError: (e) => setProblem(errorText(e)) },
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    let fils: bigint;
    try {
      fils = parseFils(amount.trim());
    } catch (e) {
      if (e instanceof MoneyFormatError) return setProblem(t('movement.badAmount'));
      throw e;
    }
    if (fils <= 0n) return setProblem(t('movement.badAmount'));
    if (paid && !reasonId) return setProblem(t('movement.reasonRequired'));
    const reason = reasons.find((r) => r.id === reasonId);
    if (reason?.requiresNote && !note.trim()) return setProblem(t('movement.noteRequired'));
    if (props.kind === 'paid_out' && !can('cash.paid_out')) return setApproving(fils);
    send(fils);
  };
  return (
    <>
      <Dialog isOpen onClose={props.onClose} title={t(`movement.${props.kind}`)}>
        <form onSubmit={submit} noValidate className={styles.payForm}>
          <TextField
            label={t('movement.amount')}
            value={amount}
            onChange={setAmount}
            inputMode="decimal"
            ltr
            autoFocus
          />
          {paid && (
            <SelectField
              id="movement-reason"
              label={t('movement.reason')}
              value={reasonId}
              onChange={setReasonId}
              options={[
                { value: '', label: t('movement.chooseReason') },
                ...reasons.map((r) => ({ value: r.id, label: localName(i18n.language)(r) })),
              ]}
            />
          )}
          <TextField label={t('movement.note')} value={note} onChange={setNote} />
          {problem && <Alert>{problem}</Alert>}
          <DialogFooter>
            <Button onPress={props.onClose}>{t('cancel')}</Button>
            <Button type="submit" variant="primary" busy={save.isPending}>
              {t('movement.save')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      {approving !== null && (
        <ApprovalDialog
          permission="cash.paid_out"
          title={t('approval.cash.paid_out.title')}
          explanation={t('approval.cash.paid_out.explain')}
          context={{ amountFils: approving.toString() }}
          onClose={() => setApproving(null)}
          onApproved={(id) => {
            const fils = approving;
            setApproving(null);
            send(fils, id);
          }}
        />
      )}
    </>
  );
}
