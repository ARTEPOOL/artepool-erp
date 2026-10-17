/**
 * Account menu → Approval PIN: the owner, the accountant and other supervisors who sign in with a
 * password choose the 4-digit PIN they type when approving something for someone else (a
 * discount, a return, cancelling an invoice). It never signs anyone in: PIN sign-in is for
 * cashiers on POS PCs only (decision 0021). The current password confirms the change.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSave } from '../api/hooks';
import { useErrorText } from '../features/auth/context';
import { Alert, Button, Dialog, DialogFooter, Note, TextField, useToast } from '../ui';

export function ApprovalPinDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('settings');
  const errorText = useErrorText();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSave(
    (api, body: { current: string; newPin: string }) => api.post('/api/v1/auth/change-pin', body),
    {
      onSuccess: () => {
        toast(t('approvalPin.saved'));
        onClose();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (!password) return setProblem(t('approvalPin.passwordRequired'));
    if (!/^\d{4}$/.test(pin)) return setProblem(t('approvalPin.fourDigits'));
    if (pin !== again) return setProblem(t('approvalPin.mismatch'));
    save.mutate(
      { current: password, newPin: pin },
      {
        onError: (e) => {
          setPassword('');
          setProblem(errorText(e));
        },
      },
    );
  };
  return (
    <Dialog isOpen onClose={onClose} title={t('approvalPin.title')}>
      <form onSubmit={submit} noValidate>
        <Note>{t('approvalPin.help')}</Note>
        <TextField
          label={t('approvalPin.password')}
          value={password}
          onChange={setPassword}
          type="password"
          autoComplete="current-password"
          autoFocus
        />
        <TextField
          label={t('approvalPin.pin')}
          value={pin}
          onChange={setPin}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          ltr
        />
        <TextField
          label={t('approvalPin.again')}
          value={again}
          onChange={setAgain}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          ltr
        />
        {problem && <Alert>{problem}</Alert>}
        <DialogFooter>
          <Button onPress={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {t('approvalPin.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
