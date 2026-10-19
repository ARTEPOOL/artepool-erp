/**
 * Connecting the dedicated Google account for the off-site copies (decision 0086): the owner
 * enters the app's Google client (made once, see the runbook), then types the code shown here at
 * google.com/device on any phone or PC, signed in with the backup account. The app keeps asking
 * Google until the owner approves.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { DriveConnectResponse, DriveFinishResponse } from '@artepool/shared/contracts';
import { useApi } from '../../../api/hooks';
import { formatTime } from '../../../lib/format';
import { Alert, Button, Dialog, DialogFooter, Note, TextField, useToast } from '../../../ui';
import { useErrorText } from '../../auth/context';
import styles from './backup.module.css';
import { HEALTH_KEY } from './BackupPanel';

export function DriveDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('settings');
  const api = useApi();
  const queryClient = useQueryClient();
  const toast = useToast();
  const errorText = useErrorText();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [code, setCode] = useState<DriveConnectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(
        await api.post<DriveConnectResponse>('/api/v1/backup/drive/connect', {
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  // Ask Google every few seconds until the owner approved at google.com/device.
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
            await queryClient.invalidateQueries({ queryKey: HEALTH_KEY });
            toast(t('backup.driveConnectedToast'));
            onClose();
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
  }, [api, code, errorText, onClose, queryClient, t, toast]);

  return (
    <Dialog isOpen onClose={onClose} title={t('backup.connectDrive')}>
      <div className={styles.form}>
        {!code ? (
          <>
            <p>{t('backup.driveExplain')}</p>
            <TextField label={t('backup.clientId')} value={clientId} onChange={setClientId} ltr />
            <TextField
              label={t('backup.clientSecret')}
              value={clientSecret}
              onChange={setClientSecret}
              type="password"
              ltr
            />
            <Note>{t('backup.driveRunbook')}</Note>
            {error && <Alert>{error}</Alert>}
            <DialogFooter>
              <Button onPress={onClose}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                busy={busy}
                isDisabled={clientId.trim().length < 10 || clientSecret.trim().length < 10}
                onPress={() => void start()}
              >
                {t('backup.next')}
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
      </div>
    </Dialog>
  );
}
