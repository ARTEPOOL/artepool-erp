/**
 * System health → the hardware check (M7 part D, decision 0119). Owner only. The newest check of
 * each PC (all «تمام», or the steps with a problem and their notes), the check of this PC, and
 * whether the shop is ready for go-live: the last rehearsal green and the POS PC's check all OK
 * (the accountant's sign-off is given outside the app).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { HardwareChecksResponse, RehearsalsResponse } from '@artepool/shared/contracts';
import { useApi } from '../../../api/hooks';
import { formatDateTime } from '../../../lib/format';
import { Alert, Button, Card, Chip } from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { CardHead } from '../parts';
import styles from './backup.module.css';
import { HardwareCheckDialog, HARDWARE_KEY } from './HardwareCheckDialog';
import { REHEARSAL_KEY } from './RehearsalCard';

export function HardwareCheckCard() {
  const { t, i18n } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const errorText = useErrorText();
  const [checking, setChecking] = useState(false);
  const checks = useQuery({
    queryKey: HARDWARE_KEY,
    queryFn: () => api.get<HardwareChecksResponse>('/api/v1/system/hardware-checks'),
  });
  const rehearsals = useQuery({
    queryKey: REHEARSAL_KEY,
    queryFn: () => api.get<RehearsalsResponse>('/api/v1/system/rehearsals'),
    enabled: can('system.rehearsal'),
  });
  const data = checks.data;
  const name = (p: { displayNameAr: string; displayNameEn: string }) =>
    i18n.language === 'ar' ? p.displayNameAr : p.displayNameEn;
  const rehearsalGreen = rehearsals.data?.latest?.status === 'passed';
  const posOk = data?.checks.some((c) => c.allOk && c.results.some((r) => r.step === 'scan'));

  return (
    <Card rise index={2} aria-label={t('hardware.title')}>
      <CardHead title={t('hardware.title')} />
      {checks.error && <Alert>{errorText(checks.error)}</Alert>}
      {data && (
        <div className={styles.places} data-testid="hardware-card">
          {data.checks.length === 0 && (
            <div className={styles.muted} data-testid="hardware-none">
              {t('hardware.none')}
            </div>
          )}
          {data.checks.map((c) => (
            <div className={styles.place} key={c.id} data-testid={`hardware-check-${c.deviceCode}`}>
              <span />
              <div>
                <b>
                  <bdi>{c.deviceCode}</bdi>{' '}
                  <Chip tone={c.allOk ? 'ok' : 'danger'}>
                    {c.allOk ? t('hardware.allOk') : t('hardware.hasProblem')}
                  </Chip>
                </b>
                <div className={styles.muted}>
                  {t('hardware.checkedBy', {
                    date: formatDateTime(c.checkedAt),
                    name: name(c.checkedBy),
                  })}
                </div>
                {c.results
                  .filter((r) => r.outcome === 'problem')
                  .map((r) => (
                    <div className={styles.muted} key={r.step}>
                      ✗ {t(`hardware.step.${r.step}`)}
                      {r.note && (
                        <>
                          : <bdi>{r.note}</bdi>
                        </>
                      )}
                    </div>
                  ))}
              </div>
              <span />
            </div>
          ))}
          <div className={styles.place}>
            <span />
            <div>
              <b>{t('hardware.thisPc')}</b>
              <div className={styles.muted}>
                {data.steps.map((s) => t(`hardware.step.${s}`)).join(' · ')}
              </div>
            </div>
            {can('system.health.manage') && (
              <div className={styles.placeActions}>
                <Button variant="primary" onPress={() => setChecking(true)}>
                  {t('hardware.start')}
                </Button>
              </div>
            )}
          </div>
          {can('system.rehearsal') && (
            <div className={styles.place} data-testid="go-live-ready">
              <span />
              <div>
                <b>
                  {rehearsalGreen && posOk ? (
                    <Chip tone="ok">{t('hardware.ready')}</Chip>
                  ) : (
                    t('hardware.notReady')
                  )}
                </b>
                <div className={styles.muted}>
                  {rehearsalGreen ? '✓' : '✗'} {t('hardware.readyRehearsal')} · {posOk ? '✓' : '✗'}{' '}
                  {t('hardware.readyHardware')} · {t('hardware.readyAccountant')}
                </div>
              </div>
              <span />
            </div>
          )}
        </div>
      )}
      {checking && data && (
        <HardwareCheckDialog steps={data.steps} onClose={() => setChecking(false)} />
      )}
    </Card>
  );
}
