import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { AlertTriangle, Delete, KeyRound, LayoutGrid } from 'lucide-react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  cx,
  Dialog,
  DialogFooter,
  iconClass,
  Note,
  Segmented,
  TextField,
} from '../../ui';
import styles from './auth.module.css';
import { useAuthController, useAuthState, useDisplayName, useErrorText } from './context';
import { toAsciiDigits } from './OtpInput';
import { AuthFrame, Hello, ServerChip, ServerDown } from './parts';

const USERNAME_KEY = 'artepool.username';
const REMEMBER_KEY = 'artepool.rememberUsername';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not remembered on this PC; nothing else changes.
  }
}

/** Design 01: password sign-in, and PIN sign-in on POS counters (decision 0021). */
export function SignInScreen() {
  const { t } = useTranslation('auth');
  const { device, phase } = useAuthState();
  const pinAllowed = device?.kind === 'pos';
  const [method, setMethod] = useState<'password' | 'pin'>(pinAllowed ? 'pin' : 'password');
  const notice = phase.name === 'signIn' ? phase.notice : null;
  const usePin = pinAllowed && method === 'pin';

  return (
    <AuthFrame wide={usePin}>
      <Hello
        title={usePin ? t('pin.title') : t('signIn.title')}
        subtitle={usePin ? t('pin.subtitle') : t('signIn.subtitle')}
      />
      <div className={cx(styles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        {pinAllowed && (
          <Segmented
            label={t('signIn.method')}
            block
            value={method}
            onChange={setMethod}
            options={[
              {
                value: 'password',
                label: t('signIn.password'),
                icon: <KeyRound aria-hidden="true" />,
              },
              { value: 'pin', label: t('signIn.pin'), icon: <LayoutGrid aria-hidden="true" /> },
            ]}
          />
        )}
        {notice && <Note>{t(`signIn.${notice}`)}</Note>}
        <ServerDown />
        {usePin ? <PinForm /> : <PasswordForm />}
      </div>
      <ServerChip />
    </AuthFrame>
  );
}

function PasswordForm() {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const { server } = useAuthState();
  const errorText = useErrorText();
  const [remember, setRemember] = useState(stored(REMEMBER_KEY) !== '0');
  const [username, setUsername] = useState(() => stored(USERNAME_KEY) ?? '');
  const [password, setPassword] = useState('');
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState<{ text: string; wrong: boolean; attempt: number } | null>(
    null,
  );
  const [lockedUser, setLockedUser] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const serverDown = server === 'down' || server === 'untrusted';

  const fail = (text: string, wrong = false) =>
    setError((previous) => ({ text, wrong, attempt: (previous?.attempt ?? 0) + 1 }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = username.trim();
    if (!name || !password) return fail(t('signIn.missing'));
    setBusy(true);
    try {
      store(REMEMBER_KEY, remember ? '1' : '0');
      store(USERNAME_KEY, remember ? name : null);
      await controller.signInWithPassword(name, password);
    } catch (caught) {
      setPassword('');
      if (caught instanceof ApiError && caught.isConnection) {
        setError(null);
      } else {
        const code = caught instanceof ApiError ? caught.code : '';
        if (code === 'ACCOUNT_LOCKED') setLockedUser(name);
        fail(errorText(caught), code === 'INVALID_CREDENTIALS');
      }
    } finally {
      setBusy(false);
    }
  };

  const capsWarning = capsLock ? (
    <span className={styles.caps}>
      <AlertTriangle aria-hidden="true" />
      {t('signIn.capsLock')}
    </span>
  ) : undefined;

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      {error && (
        <Alert key={error.attempt} shake>
          {error.text}
        </Alert>
      )}
      <TextField
        label={t('signIn.username')}
        name="username"
        value={username}
        onChange={(value) => {
          setUsername(value);
          if (lockedUser && value.trim() !== lockedUser) setLockedUser(null);
        }}
        size="lg"
        ltr
        invalid={error?.wrong}
        autoComplete="username"
        autoFocus={username === ''}
      />
      <TextField
        label={t('signIn.password')}
        name="password"
        type="password"
        value={password}
        onChange={setPassword}
        size="lg"
        ltr
        invalid={error?.wrong}
        autoComplete="current-password"
        autoFocus={username !== ''}
        onKeyUp={(event) => setCapsLock(event.getModifierState('CapsLock'))}
        hint={capsWarning}
      />
      <Checkbox isSelected={remember} onChange={setRemember}>
        {t('signIn.remember')}
      </Checkbox>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        block
        busy={busy}
        isDisabled={busy || serverDown || lockedUser === username.trim()}
      >
        {t('signIn.submit')}
      </Button>
      <AriaButton className={styles.link} onPress={() => setForgotOpen(true)}>
        {t('signIn.forgot')}
      </AriaButton>
      <Dialog isOpen={forgotOpen} onClose={() => setForgotOpen(false)} title={t('forgot.title')}>
        <p>{t('forgot.twoStep')}</p>
        <p>{t('forgot.staff')}</p>
        <DialogFooter>
          <Button onPress={() => setForgotOpen(false)}>{t('forgot.ok')}</Button>
          <Button
            variant="primary"
            isDisabled={serverDown}
            onPress={() => {
              setForgotOpen(false);
              controller.openPasswordRecovery();
            }}
          >
            {t('forgot.recover')}
          </Button>
        </DialogFooter>
      </Dialog>
    </form>
  );
}

function PinForm() {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const { server } = useAuthState();
  const errorText = useErrorText();
  const nameOf = useDisplayName();
  const users = useQuery({ queryKey: ['pin-users'], queryFn: () => controller.pinUsers() });
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<{ text: string; attempt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const serverDown = server === 'down' || server === 'untrusted';

  const people = users.data?.users ?? [];
  const chosen = people.find((p) => p.id === selected && !p.blocked) ?? null;

  const fail = (text: string) =>
    setError((previous) => ({ text, attempt: (previous?.attempt ?? 0) + 1 }));

  const tryPin = async (code: string) => {
    if (!chosen) return fail(t('pin.pickName'));
    if (code.length < 4) return fail(t('pin.missing'));
    setBusy(true);
    try {
      await controller.signInWithPin(chosen.id, code);
    } catch (caught) {
      setPin('');
      if (caught instanceof ApiError && caught.isConnection) return setError(null);
      if (caught instanceof ApiError && caught.code === 'PIN_BLOCKED') void users.refetch();
      fail(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const press = (key: string) => {
    if (busy) return;
    setError(null);
    if (key === 'clear') return setPin('');
    if (key === 'back') return setPin((value) => value.slice(0, -1));
    if (!chosen) return fail(t('pin.pickName'));
    if (pin.length >= 4) return;
    const next = pin + key;
    setPin(next);
    if (next.length === 4) setTimeout(() => void tryPin(next), 150);
  };

  // Digits typed on the keyboard work too (design 01).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [role="dialog"]')) return;
      const digit = toAsciiDigits(event.key);
      if (/^[0-9]$/.test(digit)) press(digit);
      else if (event.key === 'Backspace') press('back');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void tryPin(pin);
      }}
      noValidate
    >
      <div className={styles.field}>
        <span className={styles.label} id="pin-who">
          {t('pin.who')}
        </span>
        {users.isSuccess && people.length === 0 ? (
          <Note>{t('pin.none')}</Note>
        ) : (
          <div className={styles.people} role="group" aria-labelledby="pin-who">
            {people.map((person) => (
              <button
                key={person.id}
                type="button"
                className={styles.person}
                aria-pressed={person.id === selected}
                disabled={person.blocked}
                onClick={() => {
                  setSelected(person.id);
                  setPin('');
                  setError(null);
                }}
              >
                <Avatar name={nameOf(person)} />
                <span>{nameOf(person)}</span>
                {person.blocked && <span className={styles.blockedTag}>({t('pin.blocked')})</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        className={styles.dots}
        role="status"
        aria-label={t('pin.entered', { count: pin.length })}
      >
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={cx(i < pin.length && styles.on)} />
        ))}
      </div>
      <div className={styles.pad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button key={digit} type="button" onClick={() => press(digit)}>
            {digit}
          </button>
        ))}
        <button type="button" onClick={() => press('clear')}>
          <span className={styles.padText}>{t('pin.clear')}</span>
        </button>
        <button type="button" onClick={() => press('0')}>
          0
        </button>
        <button type="button" onClick={() => press('back')} aria-label={t('pin.delete')}>
          <Delete className={iconClass.md} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <Alert key={error.attempt} shake>
          {error.text}
        </Alert>
      )}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        block
        busy={busy}
        isDisabled={busy || serverDown}
      >
        {t('signIn.submit')}
      </Button>
    </form>
  );
}
