import { Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { Button, Card, iconClass } from '../../ui';
import { useAuthState, useCan, useDisplayName } from '../auth/context';
import { canSeeSettings } from '../settings/sections';
import { PageHeader, settingsClasses } from '../settings/parts';
import { StockAlerts } from './StockAlerts';

/**
 * Until the dashboard (design 02) arrives with sales: a welcome, the stock alerts, and the way to
 * Settings.
 */
export function HomePage() {
  const { t } = useTranslation('settings');
  const { user } = useAuthState();
  const nameOf = useDisplayName();
  const can = useCan();
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title={t('home.welcome', { name: user ? nameOf(user) : '' })} />
      <StockAlerts />
      <Card rise index={1} className={settingsClasses.ucard}>
        <p>{t('home.next')}</p>
        {canSeeSettings(can) && (
          <div className={settingsClasses.uacts}>
            <Button variant="primary" onPress={() => void navigate({ to: '/settings' })}>
              <Settings className={iconClass.sm} aria-hidden="true" />
              {t('home.openSettings')}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
