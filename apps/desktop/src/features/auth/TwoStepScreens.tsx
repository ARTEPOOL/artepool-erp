import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Copy, Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { TwoStepStartResponse } from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { Alert, Button, Checkbox, cx, iconClass, Note, useToast } from '../../ui';
import styles from './auth.module.css';
import { useAuthController, useAuthState, useErrorText } from './context';
import { OtpInput } from './OtpInput';
import { QrCode } from './QrCode';
import { AuthFrame, Hello, ServerDown } from './parts';

/** The key in groups of four, easier to type into a phone. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

/**
 * Owner 2-step setup (decision 0022): scan, then prove it works with one code. The first-run
 * wizard passes its own `start` / `confirm` (nobody is signed in there yet) and a step title.
 */
export function TwoStepSetupScreen(props: {
  start?: () => Promise<TwoStepStartResponse>;
  confirm?: (code: string) => Promise<void>;
  above?: ReactNode;
}) {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const { session } = useAuthState();
  const errorText = useErrorText();
  // A new secret each time this screen opens; it stays on the server only until confirmed.
  const setup = useQuery({
    queryKey: ['two-step-setup', props.start ? 'wizard' : 'sign-in'],
    queryFn: () => (props.start ?? (() => controller.twoStepStart()))(),
    staleTime: Infinity,
    gcTime: 0,
  });
  const [code, setCode] = useState('');
  const [error, setError] = useState<{ text: string; attempt: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (text: string) =>
    setError((previous) => ({ text, attempt: (previous?.attempt ?? 0) + 1 }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== 6) return fail(t('twoStep.incomplete'));
    setBusy(true);
    try {
      await (props.confirm ?? ((value: string) => controller.twoStepConfirm(value)))(code);
    } catch (caught) {
      setCode('');
      if (caught instanceof ApiError && caught.isConnection) setError(null);
      else fail(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame wide>
      {props.above}
      <Hello title={t('twoStep.title')} subtitle={t('twoStep.subtitle')} />
      <form
        className={cx(styles.form, 'rise')}
        style={{ '--i': 2 } as CSSProperties}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <ServerDown />
        {session?.authMethod === 'recovery_code' && <Note>{t('twoStep.again')}</Note>}
        <span className={styles.label}>{t('twoStep.scan')}</span>
        {setup.data ? (
          <>
            <QrCode text={setup.data.uri} label={t('twoStep.qrLabel')} />
            <span className={styles.label}>{t('twoStep.manual')}</span>
            <code className={styles.secret}>{grouped(setup.data.secret)}</code>
          </>
        ) : setup.isError ? (
          <Alert>{errorText(setup.error)}</Alert>
        ) : (
          <Note>{t('twoStep.loading')}</Note>
        )}
        <span className={styles.label}>{t('twoStep.enter')}</span>
        <OtpInput
          value={code}
          onChange={(value) => {
            setCode(value);
            setError(null);
          }}
          invalid={error !== null}
          label={t('twoStep.code')}
        />
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
          isDisabled={busy || !setup.data}
        >
          {t('twoStep.confirm')}
        </Button>
      </form>
    </AuthFrame>
  );
}

/** The 10 recovery codes, shown once (decision 0022). */
export function RecoveryCodesScreen({
  codes,
  onSaved,
  above,
}: {
  codes: string[];
  /** The first-run wizard goes on to its next step instead. */
  onSaved?: () => Promise<void> | void;
  above?: ReactNode;
}) {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast(t('recovery.copied'));
    } catch {
      // The clipboard is not available here; printing still works.
    }
  };

  const proceed = async () => {
    setBusy(true);
    try {
      await (onSaved ?? (() => controller.recoveryCodesSaved()))();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame wide>
      {above}
      <Hello title={t('recovery.title')} subtitle={t('recovery.subtitle')} />
      <div className={cx(styles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        <ol className={styles.codes} aria-label={t('recovery.title')}>
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ol>
        <div className={cx(styles.row, styles.noPrint)}>
          <Button onPress={() => window.print()}>
            <Printer className={iconClass.sm} aria-hidden="true" />
            {t('recovery.print')}
          </Button>
          <Button onPress={() => void copy()}>
            <Copy className={iconClass.sm} aria-hidden="true" />
            {t('recovery.copy')}
          </Button>
        </div>
        <Checkbox isSelected={saved} onChange={setSaved} className={styles.noPrint}>
          {t('recovery.saved')}
        </Checkbox>
        <Button
          variant="primary"
          size="lg"
          block
          busy={busy}
          isDisabled={!saved || busy}
          onPress={() => void proceed()}
          className={styles.noPrint}
        >
          {t('recovery.continue')}
        </Button>
      </div>
    </AuthFrame>
  );
}
