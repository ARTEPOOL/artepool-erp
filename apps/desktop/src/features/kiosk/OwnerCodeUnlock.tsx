/**
 * "Unlock with owner code" on a locked POS PC's sign-in and lock screens (decision 0083): someone
 * types the owner's current 6-digit code, read from the owner's phone; the kiosk lock lifts for
 * at most 5 minutes. The server checks the code, accepts it once and limits wrong tries.
 */
import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../api/hooks';
import { Alert, Button, Dialog, DialogFooter, iconClass, Note } from '../../ui';
import { useErrorText } from '../auth/context';
import { OtpInput } from '../auth/OtpInput';
import styles from './kiosk.module.css';
import { KIOSK_KEY, useKiosk } from './state';

export function OwnerCodeUnlock() {
  const { t } = useTranslation('auth');
  const kiosk = useKiosk();
  const [open, setOpen] = useState(false);
  if (!kiosk?.isPos || !kiosk.locked) return null;
  return (
    <div className={styles.owner}>
      <Button variant="ghost" onPress={() => setOpen(true)}>
        <KeyRound className={iconClass.sm} aria-hidden="true" />
        {t('kiosk.ownerCode')}
      </Button>
      {open && <OwnerCodeDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function OwnerCodeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('auth');
  const api = useApi();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError(t('kiosk.codeMissing'));
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/v1/kiosk/unlock-with-code', { code });
      await queryClient.invalidateQueries({ queryKey: KIOSK_KEY });
      onClose();
    } catch (caught) {
      setCode('');
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen onClose={onClose} title={t('kiosk.ownerCodeTitle')}>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <Note>{t('kiosk.ownerCodeHelp')}</Note>
        {error && <Alert>{error}</Alert>}
        <OtpInput label={t('kiosk.ownerCodeLabel')} value={code} onChange={setCode} autoFocus />
        <DialogFooter>
          <Button onPress={onClose}>{t('kiosk.cancel')}</Button>
          <Button type="submit" variant="primary" busy={busy} isDisabled={busy}>
            {t('kiosk.unlock')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
