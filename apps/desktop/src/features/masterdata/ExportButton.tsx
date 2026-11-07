/**
 * «تصدير إلى Excel» (M7 part E): the server's export in the import's own columns, saved through
 * the browser's download. Shown only with `data.export`; the server checks it again and logs it.
 */
import { useState } from 'react';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FilePayload } from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { Button, iconClass, useToast } from '../../ui';
import { useErrorText } from '../auth/context';
import { downloadFile } from './files';

export function ExportButton(props: { url: string }) {
  const { t } = useTranslation('masterdata');
  const api = useApi();
  const toast = useToast();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      downloadFile(await api.get<FilePayload>(props.url));
    } catch (error) {
      toast(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button busy={busy} onPress={() => void run()}>
      <Download className={iconClass.sm} aria-hidden="true" />
      {t('actions.export')}
    </Button>
  );
}
