import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Dialog, DialogFooter, InfoBar, TextField } from '../../ui';
import { useErrorText } from '../auth/context';
import styles from './masterdata.module.css';

/**
 * Deactivating a record (decision 0037): nothing is ever deleted; a written reason is required and
 * kept in the audit log. The record can be reactivated later.
 */
export function DeactivateDialog(props: {
  title: ReactNode;
  /** Who or what is being deactivated, shown above the reason. */
  subject: ReactNode;
  /** Why the record is not deleted and what deactivating does. */
  explanation?: ReactNode;
  busy: boolean;
  error: unknown;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('masterdata');
  const errorText = useErrorText();
  const [reason, setReason] = useState('');
  const [tooShort, setTooShort] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim().length < 3) return setTooShort(true);
    setTooShort(false);
    props.onConfirm(reason.trim());
  };

  return (
    <Dialog isOpen onClose={props.onClose} title={props.title}>
      <form onSubmit={submit} noValidate className={styles.form}>
        <InfoBar>{props.explanation ?? t('deactivate.neverDeleted')}</InfoBar>
        <div>{props.subject}</div>
        {props.error !== null && props.error !== undefined && (
          <Alert>{errorText(props.error)}</Alert>
        )}
        <TextField
          label={t('deactivate.reason')}
          value={reason}
          onChange={setReason}
          multiline
          autoFocus
          isRequired
          placeholder={t('deactivate.reasonHint')}
          error={tooShort ? t('deactivate.reasonTooShort') : undefined}
        />
        <DialogFooter>
          <Button onPress={props.onClose}>{t('actions.cancel')}</Button>
          <Button type="submit" variant="danger" busy={props.busy}>
            {t('deactivate.confirm')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
