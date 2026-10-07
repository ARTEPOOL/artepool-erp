import { useState, type CSSProperties, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Alert, Button, cx, iconClass, Note, TextField } from '../../ui';
import styles from './auth.module.css';
import { useAuthController, useAuthState, useErrorText } from './context';
import { OtpInput } from './OtpInput';
import { AuthFrame, Hello, ServerChip, ServerDown } from './parts';

const USERNAME_KEY = 'artepool.username';

function rememberedUsername(): string {
  try {
    return localStorage.getItem(USERNAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * Forgot password (decision 0028): the username, the phone code, one recovery code and a new
 * password. The server checks everything; one answer for any wrong part.
 */
export function RecoverPasswordScreen() {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const { server } = useAuthState();
  const errorText = useErrorText();
  const [username, setUsername] = useState(rememberedUsername);
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [error, setError] = useState<{ text: string; problems: string[]; attempt: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const serverDown = server === 'down' || server === 'untrusted';

  const fail = (text: string, problems: string[] = []) =>
    setError((previous) => ({ text, problems, attempt: (previous?.attempt ?? 0) + 1 }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || code.length !== 6 || !recoveryCode.trim() || !first || !second) {
      return fail(t('passwordRecovery.missing'));
    }
    if (first !== second) return fail(t('change.mismatch'));
    setBusy(true);
    try {
      await controller.recoverPassword({
        username: username.trim(),
        code,
        recoveryCode: recoveryCode.trim(),
        newPassword: first,
      });
    } catch (caught) {
      setCode('');
      if (caught instanceof ApiError && caught.isConnection) return setError(null);
      const problems =
        caught instanceof ApiError && Array.isArray(caught.details.problems)
          ? (caught.details.problems as string[])
          : [];
      const minLength = caught instanceof ApiError ? caught.details.minLength : undefined;
      if (problems.length > 0) {
        setFirst('');
        setSecond('');
      } else {
        setRecoveryCode('');
      }
      fail(
        errorText(caught),
        problems.map((p) => t(`change.problems.${p}`, { minLength: minLength ?? 10 })),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <Hello title={t('passwordRecovery.title')} subtitle={t('passwordRecovery.subtitle')} />
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
        <TextField
          label={t('signIn.username')}
          name="username"
          value={username}
          onChange={setUsername}
          size="lg"
          ltr
          autoComplete="username"
          autoFocus={username === ''}
        />
        <div className={styles.field}>
          <span className={styles.label} aria-hidden="true">
            {t('passwordRecovery.code')}
          </span>
          <OtpInput
            value={code}
            onChange={setCode}
            autoFocus={username !== ''}
            label={t('passwordRecovery.code')}
          />
        </div>
        <TextField
          label={t('secondFactor.recoveryLabel')}
          value={recoveryCode}
          onChange={setRecoveryCode}
          size="lg"
          ltr
          autoComplete="off"
          maxLength={32}
          hint={t('secondFactor.recoveryHint')}
        />
        <TextField
          label={t('change.newPassword')}
          type="password"
          value={first}
          onChange={setFirst}
          size="lg"
          ltr
          autoComplete="new-password"
          hint={t('change.passwordHint')}
        />
        <TextField
          label={t('change.again')}
          type="password"
          value={second}
          onChange={setSecond}
          size="lg"
          ltr
          autoComplete="new-password"
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          busy={busy}
          isDisabled={busy || serverDown}
        >
          {t('passwordRecovery.save')}
        </Button>
        <Button variant="ghost" onPress={() => controller.backToSignIn()}>
          <ArrowLeft className={cx(iconClass.sm, 'flip-rtl')} aria-hidden="true" />
          {t('secondFactor.back')}
        </Button>
      </form>
      <ServerChip />
    </AuthFrame>
  );
}

/** After a recovery: how many recovery codes are left, and what else changed. */
export function PasswordRecoveredScreen({ codesLeft }: { codesLeft: number }) {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const [busy, setBusy] = useState(false);

  const proceed = async () => {
    setBusy(true);
    try {
      await controller.passwordRecoveredSeen();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame>
      <Hello title={t('passwordRecovery.doneTitle')} />
      <div className={cx(styles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        {codesLeft <= 3 ? (
          <Alert tone="warn">{t('passwordRecovery.left', { count: codesLeft })}</Alert>
        ) : (
          <Note>{t('passwordRecovery.left', { count: codesLeft })}</Note>
        )}
        <Note>{t('passwordRecovery.ended')}</Note>
        <Button
          variant="primary"
          size="lg"
          block
          busy={busy}
          isDisabled={busy}
          onPress={() => void proceed()}
        >
          {t('passwordRecovery.continue')}
        </Button>
      </div>
    </AuthFrame>
  );
}
