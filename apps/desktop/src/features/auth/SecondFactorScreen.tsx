import { useState, type CSSProperties, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Alert, Button, cx, iconClass, TextField } from '../../ui';
import styles from './auth.module.css';
import { useAuthController, useErrorText } from './context';
import { OtpInput } from './OtpInput';
import { AuthFrame, Hello, ServerChip, ServerDown } from './parts';

/** Design 01 "owner code": the 6-digit code, or one recovery code (decision 0022). */
export function SecondFactorScreen() {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const errorText = useErrorText();
  const [mode, setMode] = useState<'app' | 'recovery'>('app');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<{ text: string; attempt: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (text: string) =>
    setError((previous) => ({ text, attempt: (previous?.attempt ?? 0) + 1 }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'app' && code.length !== 6) return fail(t('secondFactor.incomplete'));
    if (mode === 'recovery' && !recoveryCode.trim()) return fail(t('secondFactor.recoveryMissing'));
    setBusy(true);
    try {
      await controller.secondFactor(
        mode === 'app' ? { code } : { recoveryCode: recoveryCode.trim() },
      );
    } catch (caught) {
      setCode('');
      setRecoveryCode('');
      if (caught instanceof ApiError && caught.isConnection) setError(null);
      else fail(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setMode(mode === 'app' ? 'recovery' : 'app');
    setError(null);
  };

  return (
    <AuthFrame>
      <Hello
        title={t('secondFactor.title')}
        subtitle={mode === 'app' ? t('secondFactor.subtitle') : t('secondFactor.recoveryHint')}
      />
      <form
        className={cx(styles.form, 'rise')}
        style={{ '--i': 2 } as CSSProperties}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <ServerDown />
        {mode === 'app' ? (
          <OtpInput
            value={code}
            onChange={(value) => {
              setCode(value);
              setError(null);
            }}
            invalid={error !== null}
            autoFocus
            label={t('secondFactor.subtitle')}
          />
        ) : (
          <TextField
            label={t('secondFactor.recoveryLabel')}
            value={recoveryCode}
            onChange={setRecoveryCode}
            size="lg"
            ltr
            autoFocus
            autoComplete="off"
            maxLength={32}
            invalid={error !== null}
          />
        )}
        {error && (
          <Alert key={error.attempt} shake>
            {error.text}
          </Alert>
        )}
        <Button type="submit" variant="primary" size="lg" block busy={busy} isDisabled={busy}>
          {t('secondFactor.confirm')}
        </Button>
        <AriaButton className={styles.link} onPress={switchMode}>
          {mode === 'app' ? t('secondFactor.useRecovery') : t('secondFactor.useApp')}
        </AriaButton>
        <Button variant="ghost" onPress={() => void controller.cancelSignIn()}>
          <ArrowLeft className={cx(iconClass.sm, 'flip-rtl')} aria-hidden="true" />
          {t('secondFactor.back')}
        </Button>
      </form>
      <ServerChip />
    </AuthFrame>
  );
}
