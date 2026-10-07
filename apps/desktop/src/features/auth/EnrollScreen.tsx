import { useState, type CSSProperties, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { EnrollFailure, EnrollInput } from '@artepool/shared/contracts';
import { Alert, Button, cx, Note, Segmented, TextField, useToast } from '../../ui';
import styles from './auth.module.css';
import { useAuthController, useAuthState } from './context';
import { AuthFrame, Hello } from './parts';

type Kind = EnrollInput['deviceKind'];

/**
 * "Enroll this PC" (decision 0024), in the style of design 01. The code typed here also proves
 * that the server is the genuine one; the PC then trusts only the ARTÉPOOL certificate.
 */
export function EnrollScreen({ notice }: { notice: 'revoked' | 'expired' | null }) {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const { suggestedCode } = useAuthState();
  const toast = useToast();
  const [serverAddress, setServerAddress] = useState('');
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [deviceCode, setDeviceCode] = useState(suggestedCode);
  const [kind, setKind] = useState<Kind>('office');
  const [error, setError] = useState<{ text: string; attempt: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (text: string) =>
    setError((previous) => ({ text, attempt: (previous?.attempt ?? 0) + 1 }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!serverAddress.trim() || !code.trim() || !deviceName.trim()) {
      return fail(t('enroll.missing'));
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await controller.enroll({
        serverAddress: serverAddress.trim(),
        code: code.trim(),
        deviceCode: (deviceCode.trim() || suggestedCode).toUpperCase(),
        deviceName: deviceName.trim(),
        deviceKind: kind,
      });
      if (outcome.ok) toast(t('enroll.done'));
      else {
        setCode('');
        fail(t(`enroll.failures.${outcome.reason satisfies EnrollFailure}`));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame wide>
      <Hello title={t('enroll.title')} subtitle={t('enroll.subtitle')} />
      <form
        className={cx(styles.form, 'rise')}
        style={{ '--i': 2 } as CSSProperties}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {notice && <Alert tone="warn">{t(`enroll.${notice}`)}</Alert>}
        {error && (
          <Alert key={error.attempt} shake>
            {error.text}
          </Alert>
        )}
        <TextField
          label={t('enroll.server')}
          name="server"
          value={serverAddress}
          onChange={setServerAddress}
          size="lg"
          ltr
          autoFocus
          autoComplete="off"
          hint={t('enroll.serverHint')}
        />
        <TextField
          label={t('enroll.code')}
          name="code"
          value={code}
          onChange={(value) => setCode(value.toUpperCase())}
          size="lg"
          ltr
          autoComplete="off"
          maxLength={32}
          hint={t('enroll.codeHint')}
        />
        <div className={styles.two}>
          <TextField
            label={t('enroll.name')}
            name="deviceName"
            value={deviceName}
            onChange={setDeviceName}
            maxLength={100}
            hint={t('enroll.nameHint')}
          />
          <TextField
            label={t('enroll.deviceCode')}
            name="deviceCode"
            value={deviceCode}
            onChange={(value) => setDeviceCode(value.toUpperCase())}
            ltr
            maxLength={32}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label} id="enroll-kind">
            {t('enroll.kind')}
          </span>
          <Segmented
            label={t('enroll.kind')}
            block
            value={kind}
            onChange={setKind}
            options={(['pos', 'office', 'warehouse'] as const).map((value) => ({
              value,
              label: t(`enroll.kinds.${value}`),
            }))}
          />
          <Note>{t('enroll.kindHint')}</Note>
        </div>
        <Button type="submit" variant="primary" size="lg" block busy={busy} isDisabled={busy}>
          {busy ? t('enroll.working') : t('enroll.submit')}
        </Button>
      </form>
    </AuthFrame>
  );
}
