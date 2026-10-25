/**
 * Connecting the shop's Google account for the off-site copies (decisions 0086, 0095). The app's
 * registration at Google is built into the installation, so the owner only:
 * - "Choose account" (the Windows app): the browser opens Google's page, the owner chooses the
 *   shop's account and allows, and Google's answer comes back to this PC by itself;
 * - or, as a fallback (or in a browser during development), types a short code at
 *   google.com/device on any phone or PC.
 */
import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type {
  DriveAuthorizeResponse,
  DriveConnectResponse,
  DriveFinishResponse,
} from '@artepool/shared/contracts';
import { useApi } from '../../../api/hooks';
import { formatTime } from '../../../lib/format';
import { Alert, Button, Dialog, DialogFooter, Note, useToast } from '../../../ui';
import { useErrorText } from '../../auth/context';
import styles from './backup.module.css';
import { HEALTH_KEY } from './BackupPanel';

type Step = 'start' | 'browser' | 'code';

export function DriveDialog(props: {
  google: { chooseAccount: boolean; code: boolean };
  onClose: () => void;
}) {
  const { onClose } = props;
  const { t } = useTranslation('settings');
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const errorText = useErrorText();
  // Choosing the account needs the Windows app (it receives Google's answer on this PC).
  const canChoose = props.google.chooseAccount && isTauri();
  const [step, setStep] = useState<Step>(canChoose ? 'start' : 'code');
  const [code, setCode] = useState<DriveConnectResponse | null>(null);
  const [error, setError] = useState<string | null>(
    !props.google.chooseAccount && !props.google.code ? t('backup.googleMissing') : null,
  );
  const [busy, setBusy] = useState(false);

  const done = async () => {
    await queryClient.invalidateQueries({ queryKey: HEALTH_KEY });
    toast(t('backup.driveConnectedToast'));
    onClose();
  };

  const chooseAccount = async () => {
    setBusy(true);
    setError(null);
    try {
      const port = await invoke<number>('google_signin_start');
      const { authUrl } = await api.post<DriveAuthorizeResponse>('/api/v1/backup/drive/authorize', {
        redirectUri: `http://127.0.0.1:${port}/callback`,
      });
      await invoke('google_signin_open', { url: authUrl });
      setStep('browser');
      const answer = await invoke<{ code: string; state: string }>('google_signin_wait');
      await api.post<DriveFinishResponse>('/api/v1/backup/drive/callback', answer);
      await done();
    } catch (caught) {
      setStep('start');
      setError(typeof caught === 'string' ? t('backup.googleCancelled') : errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const startCode = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await api.post<DriveConnectResponse>('/api/v1/backup/drive/connect'));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  // The code way: ask Google every few seconds until the owner approved at google.com/device.
  useEffect(() => {
    if (!code) return;
    let stopped = false;
    const timer = setInterval(
      () => {
        void api
          .post<DriveFinishResponse>('/api/v1/backup/drive/finish')
          .then(async (r) => {
            if (stopped || r.status !== 'connected') return;
            stopped = true;
            clearInterval(timer);
            await done();
          })
          .catch((caught: unknown) => {
            stopped = true;
            clearInterval(timer);
            setCode(null);
            setError(errorText(caught));
          });
      },
      Math.max(code.intervalSeconds, 3) * 1000,
    );
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // `done` only invalidates, toasts and closes; it is not a reason to restart polling.
  }, [api, code, errorText]);

  return (
    <Dialog isOpen onClose={onClose} title={t('backup.connectDrive')}>
      <div className={styles.form}>
        {step === 'start' && (
          <>
            <p>{t('backup.chooseExplain')}</p>
            <Note>{t('backup.driveRunbook')}</Note>
            {error && <Alert>{error}</Alert>}
            <DialogFooter>
              {props.google.code && (
                <Button variant="ghost" onPress={() => setStep('code')}>
                  {t('backup.useCode')}
                </Button>
              )}
              <Button onPress={onClose}>{t('common.cancel')}</Button>
              <Button variant="primary" busy={busy} onPress={() => void chooseAccount()}>
                {t('backup.chooseAccount')}
              </Button>
            </DialogFooter>
          </>
        )}
        {step === 'browser' && (
          <>
            <p>{t('backup.inBrowser')}</p>
            <DialogFooter>
              <Button onPress={onClose}>{t('common.cancel')}</Button>
            </DialogFooter>
          </>
        )}
        {step === 'code' && (
          <>
            {!code ? (
              <>
                <p>{t('backup.codeExplain')}</p>
                {error && <Alert>{error}</Alert>}
                <DialogFooter>
                  <Button onPress={onClose}>{t('common.cancel')}</Button>
                  <Button
                    variant="primary"
                    busy={busy}
                    isDisabled={!props.google.code}
                    onPress={() => void startCode()}
                  >
                    {t('backup.showCode')}
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <p>{t('backup.driveStep', { url: code.verificationUrl })}</p>
                <p className={styles.code} data-testid="drive-code">
                  {code.userCode}
                </p>
                <Note>{t('backup.driveWaiting', { time: formatTime(code.expiresAt) })}</Note>
                <DialogFooter>
                  <Button onPress={onClose}>{t('common.cancel')}</Button>
                </DialogFooter>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
