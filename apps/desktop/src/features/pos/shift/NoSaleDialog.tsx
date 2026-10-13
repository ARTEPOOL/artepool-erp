/** No Sale: open the drawer without a sale — its own permission and a reason, always written. */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSave } from '../../../api/hooks';
import { Alert, Button, Dialog, DialogFooter, SelectField, TextField } from '../../../ui';
import { useErrorText } from '../../auth/context';
import { localName, useReasonCodes } from '../../masterdata/refs';
import { POS_INVALIDATE, POS_PATHS } from '../api';
import { kickDrawer } from '../receipt/printer';
import styles from '../pos.module.css';

export function NoSaleDialog(props: { onClose: () => void }) {
  const { t, i18n } = useTranslation('pos');
  const errorText = useErrorText();
  const reasons = (useReasonCodes().data ?? []).filter(
    (r) => r.category === 'no_sale' && r.isActive,
  );
  const [reasonId, setReasonId] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSave(
    (api, body: { reasonCodeId: string; note?: string }, key) =>
      api.post(POS_PATHS.noSale, body, { idempotencyKey: key }),
    {
      invalidate: POS_INVALIDATE,
      onSuccess: () => {
        void kickDrawer();
        props.onClose();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!reasonId) return setProblem(t('movement.reasonRequired'));
    save.mutate(
      { reasonCodeId: reasonId, ...(note.trim() ? { note: note.trim() } : {}) },
      { onError: (e) => setProblem(errorText(e)) },
    );
  };
  return (
    <Dialog isOpen onClose={props.onClose} title={t('noSale.title')}>
      <form onSubmit={submit} noValidate className={styles.payForm}>
        <SelectField
          id="no-sale-reason"
          label={t('movement.reason')}
          value={reasonId}
          onChange={setReasonId}
          options={[
            { value: '', label: t('movement.chooseReason') },
            ...reasons.map((r) => ({ value: r.id, label: localName(i18n.language)(r) })),
          ]}
        />
        <TextField label={t('movement.note')} value={note} onChange={setNote} />
        {problem && <Alert>{problem}</Alert>}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {t('noSale.open')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
