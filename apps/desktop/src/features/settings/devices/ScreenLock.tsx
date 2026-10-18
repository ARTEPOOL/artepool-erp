/**
 * Settings → Devices → Screen lock (decision 0079): lock the screen after some minutes without
 * use, separately for office PCs and POS PCs, or never. The session still ends after its maximum
 * length. New sign-ins use the new values. Owner only.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { ScreenLockSettings } from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { Alert, Button, Card, Note, Switch, TextField, useToast } from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { CardHead, settingsClasses as styles } from '../parts';

const KEY = ['settings', 'screen-lock'] as const;
type Field = keyof ScreenLockSettings;
const DEFAULTS: ScreenLockSettings = { officeMinutes: 15, posMinutes: 5 };

export function ScreenLockCard({ index }: { index: number }) {
  const { t } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const errorText = useErrorText();
  const allowed = can('system.settings.edit');
  const current = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<ScreenLockSettings>('/api/v1/settings/screen-lock'),
    enabled: allowed,
  });
  const [draft, setDraft] = useState<Record<Field, string> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (current.data && !draft)
      setDraft({
        officeMinutes: String(current.data.officeMinutes),
        posMinutes: String(current.data.posMinutes),
      });
  }, [current.data, draft]);
  const save = useSave(
    (client, body: ScreenLockSettings, key) =>
      client.put<ScreenLockSettings>('/api/v1/settings/screen-lock', body, { idempotencyKey: key }),
    { invalidate: [KEY], onSuccess: () => toast(t('devices.screenLock.saved')) },
  );
  if (!allowed || !draft) return null;

  const minutesOf = (text: string): number | null =>
    /^\d{1,3}$/.test(text.trim()) && Number(text) <= 240 ? Number(text) : null;
  const row = (field: Field) => {
    const on = draft[field] !== '0';
    return (
      <div key={field}>
        <Switch
          isSelected={on}
          onChange={(value) =>
            setDraft({ ...draft, [field]: value ? String(DEFAULTS[field]) : '0' })
          }
        >
          {t(`devices.screenLock.${field}`)}
        </Switch>
        {on && (
          <TextField
            label={t('devices.screenLock.minutes')}
            value={draft[field]}
            onChange={(value) => setDraft({ ...draft, [field]: value })}
            inputMode="numeric"
            ltr
            invalid={minutesOf(draft[field]) === null || draft[field] === '0'}
          />
        )}
      </div>
    );
  };
  const submit = () => {
    setProblem(null);
    const office = minutesOf(draft.officeMinutes);
    const pos = minutesOf(draft.posMinutes);
    if (office === null || pos === null) return setProblem(t('devices.screenLock.invalid'));
    save.mutate(
      { officeMinutes: office, posMinutes: pos },
      { onError: (e) => setProblem(errorText(e)) },
    );
  };

  return (
    <Card rise index={index}>
      <CardHead title={t('devices.screenLock.title')} />
      <p className={styles.helpText}>{t('devices.screenLock.help')}</p>
      {row('officeMinutes')}
      {row('posMinutes')}
      <Note>{t('devices.screenLock.note')}</Note>
      {problem && <Alert>{problem}</Alert>}
      <div className={styles.savebar}>
        <Button variant="primary" busy={save.isPending} onPress={submit}>
          {t('devices.screenLock.save')}
        </Button>
      </div>
    </Card>
  );
}
