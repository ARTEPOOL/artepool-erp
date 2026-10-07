import { useState, type CSSProperties, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Alert, Button, cx, TextField } from '../../ui';
import styles from './auth.module.css';
import { useAuthController, useErrorText } from './context';
import { toAsciiDigits } from './OtpInput';
import { AuthFrame, Hello, ServerDown } from './parts';

/**
 * First sign-in with a temporary password or PIN from the owner: the person chooses their own
 * (decisions 0021, 0023). The rules are checked by the server; its reasons are listed here.
 */
export function ChangeCredentialScreen({ credential }: { credential: 'password' | 'pin' }) {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const errorText = useErrorText();
  const isPin = credential === 'pin';
  // The temporary secret typed at sign-in is reused; it is asked again only if it has lapsed.
  const [askCurrent] = useState(() => !controller.hasPendingSecret);
  const [current, setCurrent] = useState('');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [error, setError] = useState<{ text: string; problems: string[]; attempt: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const fail = (text: string, problems: string[] = []) =>
    setError((previous) => ({ text, problems, attempt: (previous?.attempt ?? 0) + 1 }));

  const clean = (value: string) => (isPin ? toAsciiDigits(value).replace(/\s/g, '') : value);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!first || !second || (askCurrent && !current)) return fail(t('change.missing'));
    if (clean(first) !== clean(second)) return fail(t('change.mismatch'));
    setBusy(true);
    try {
      const old = askCurrent ? clean(current) : undefined;
      if (isPin) await controller.changePin(clean(first), old);
      else await controller.changePassword(first, old);
    } catch (caught) {
      setFirst('');
      setSecond('');
      if (caught instanceof ApiError && caught.isConnection) return setError(null);
      const problems =
        caught instanceof ApiError && Array.isArray(caught.details.problems)
          ? (caught.details.problems as string[])
          : [];
      const minLength = caught instanceof ApiError ? caught.details.minLength : undefined;
      fail(
        errorText(caught),
        problems.map((p) => t(`change.problems.${p}`, { minLength: minLength ?? 10 })),
      );
    } finally {
      setBusy(false);
    }
  };

  const secretProps = isPin
    ? ({ inputMode: 'numeric', maxLength: 4, autoComplete: 'off' } as const)
    : ({ autoComplete: 'new-password' } as const);

  return (
    <AuthFrame>
      <Hello
        title={isPin ? t('change.pinTitle') : t('change.passwordTitle')}
        subtitle={isPin ? t('change.pinSubtitle') : t('change.passwordSubtitle')}
      />
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
            {error.problems.length > 0 && (
              <ul className={styles.problems}>
                {error.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        {askCurrent && (
          <TextField
            label={isPin ? t('change.currentPin') : t('change.currentPassword')}
            type="password"
            value={current}
            onChange={setCurrent}
            size="lg"
            ltr
            autoFocus
            autoComplete="current-password"
          />
        )}
        <TextField
          label={isPin ? t('change.newPin') : t('change.newPassword')}
          type="password"
          value={first}
          onChange={setFirst}
          size="lg"
          ltr
          autoFocus={!askCurrent}
          hint={isPin ? t('change.pinHint') : t('change.passwordHint')}
          {...secretProps}
        />
        <TextField
          label={t('change.again')}
          type="password"
          value={second}
          onChange={setSecond}
          size="lg"
          ltr
          {...secretProps}
        />
        <Button type="submit" variant="primary" size="lg" block busy={busy} isDisabled={busy}>
          {t('change.save')}
        </Button>
      </form>
    </AuthFrame>
  );
}
