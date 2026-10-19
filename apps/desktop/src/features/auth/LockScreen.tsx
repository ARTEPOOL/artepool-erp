import { useState, type CSSProperties, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Alert, Avatar, Button, cx, TextField } from '../../ui';
import styles from './auth.module.css';
import { useAuthController, useAuthState, useDisplayName, useErrorText } from './context';
import { toAsciiDigits } from './OtpInput';
import { OwnerCodeUnlock } from '../kiosk/OwnerCodeUnlock';
import { AuthFrame, Hello, ServerDown } from './parts';

/**
 * The screen lock: after the idle minutes set in Settings → Devices (decision 0079; off on POS PCs
 * by default, 0090) or the POS "Lock screen" button. The same person continues with their own
 * password or PIN; anyone else signs in fresh, which ends this session.
 */
export function LockScreen() {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const { user } = useAuthState();
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<{ text: string; attempt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const usesPin = user?.signInMethod === 'pin';
  const name = user ? nameOf(user) : '';

  const fail = (text: string) =>
    setError((previous) => ({ text, attempt: (previous?.attempt ?? 0) + 1 }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret) return fail(t('lock.missing'));
    setBusy(true);
    try {
      await controller.unlock(usesPin ? toAsciiDigits(secret) : secret);
    } catch (caught) {
      setSecret('');
      if (caught instanceof ApiError && caught.isConnection) setError(null);
      else fail(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <div className={cx(styles.who, 'rise')}>
        <Avatar name={name} />
        <Hello
          title={t('lock.title')}
          subtitle={usesPin ? t('lock.pin', { name }) : t('lock.password', { name })}
        />
      </div>
      <form
        className={cx(styles.form, 'rise')}
        style={{ '--i': 2 } as CSSProperties}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <ServerDown />
        {error && (
          <Alert key={error.attempt} shake>
            {error.text}
          </Alert>
        )}
        <TextField
          label={usesPin ? t('signIn.pin') : t('signIn.password')}
          type="password"
          value={secret}
          onChange={setSecret}
          size="lg"
          ltr
          autoFocus
          autoComplete={usesPin ? 'off' : 'current-password'}
          {...(usesPin ? { inputMode: 'numeric' as const, maxLength: 4 } : {})}
        />
        <Button type="submit" variant="primary" size="lg" block busy={busy} isDisabled={busy}>
          {t('lock.unlock')}
        </Button>
        <Button variant="ghost" onPress={() => void controller.signOut(null)}>
          {t('lock.switchUser')}
        </Button>
      </form>
      <OwnerCodeUnlock />
    </AuthFrame>
  );
}
