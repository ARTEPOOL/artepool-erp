/**
 * Creating the backup key (decision 0086): the server makes a key pair; the private key (the
 * only key that opens the off-site copies) is shown here once, to print or save on a USB stick;
 * the owner types its last 6 characters to show it was kept; only the public key is saved.
 */
import { useState } from 'react';
import { Copy, Download, Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BackupKeyResponse } from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  iconClass,
  Note,
  TextField,
  useToast,
} from '../../../ui';
import { useErrorText } from '../../auth/context';
import styles from './backup.module.css';
import { HEALTH_KEY } from './BackupPanel';

export function KeyDialog({ replacing, onClose }: { replacing: boolean; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const api = useApi();
  const toast = useToast();
  const errorText = useErrorText();
  const [key, setKey] = useState<BackupKeyResponse | null>(null);
  const [last6, setLast6] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useSave(
    (client, body: { recipient: string }, idem) =>
      client.post('/api/v1/backup/key/confirm', body, { idempotencyKey: idem }),
    {
      invalidate: [[...HEALTH_KEY]],
      onSuccess: () => {
        toast(t('backup.keySaved'));
        onClose();
      },
    },
  );

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setKey(await api.post<BackupKeyResponse>('/api/v1/backup/key'));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (!key) return;
    const text = `ARTEPOOL ERP — backup key / مفتاح النسخ الاحتياطي\n\n${key.identity}\n\nPublic key: ${key.recipient}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'artepool-backup-key.txt';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(key?.identity ?? '');
      toast(t('backup.keyCopied'));
    } catch {
      // No clipboard here: printing and saving still work.
    }
  };
  const done = () => {
    if (!key) return;
    if (last6.trim().toUpperCase() !== key.identity.slice(-6))
      return setError(t('backup.keyLast6Wrong'));
    setError(null);
    confirm.mutate({ recipient: key.recipient }, { onError: (e) => setError(errorText(e)) });
  };

  return (
    <Dialog isOpen onClose={onClose} title={t('backup.createKey')} dismissable={key === null} wide>
      <div className={styles.form}>
        {!key ? (
          <>
            <p>{t('backup.keyExplain')}</p>
            {replacing && <Alert tone="warn">{t('backup.keyReplaceWarn')}</Alert>}
            {error && <Alert>{error}</Alert>}
            <DialogFooter>
              <Button onPress={onClose}>{t('common.cancel')}</Button>
              <Button variant="primary" busy={busy} onPress={() => void create()}>
                {t('backup.createKey')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <Alert tone="warn">{t('backup.keyOnce')}</Alert>
            <div className={styles.keySheet} data-testid="backup-key">
              <p>{t('backup.keySheetTitle')}</p>
              <p>
                <b>{key.identity}</b>
              </p>
            </div>
            <div className={styles.placeActions}>
              <Button onPress={() => window.print()}>
                <Printer className={iconClass.sm} aria-hidden="true" />
                {t('backup.print')}
              </Button>
              <Button onPress={save}>
                <Download className={iconClass.sm} aria-hidden="true" />
                {t('backup.saveFile')}
              </Button>
              <Button onPress={() => void copy()}>
                <Copy className={iconClass.sm} aria-hidden="true" />
                {t('backup.copy')}
              </Button>
            </div>
            <Note>{t('backup.keyWhere')}</Note>
            <TextField
              label={t('backup.keyLast6')}
              value={last6}
              onChange={setLast6}
              maxLength={6}
              ltr
            />
            {error && <Alert>{error}</Alert>}
            <DialogFooter>
              <Button variant="primary" busy={confirm.isPending} onPress={done}>
                {t('backup.keyDone')}
              </Button>
            </DialogFooter>
          </>
        )}
      </div>
    </Dialog>
  );
}
