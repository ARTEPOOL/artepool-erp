import type { ReactNode } from 'react';
import {
  Building2,
  Database,
  ListChecks,
  History,
  MonitorSmartphone,
  Palette,
  Percent,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { Card, cx, Tile } from '../../ui';
import { useCan } from '../auth/context';
import { NoAccess, PageHeader } from './parts';
import { allowedSections, isAllowed, SECTIONS, type SectionId } from './sections';
import styles from './settings.module.css';

const ICONS: Record<SectionId, ReactNode> = {
  company: <Building2 aria-hidden="true" />,
  users: <Users aria-hidden="true" />,
  tax: <Percent aria-hidden="true" />,
  lists: <ListChecks aria-hidden="true" />,
  devices: <MonitorSmartphone aria-hidden="true" />,
  print: <Palette aria-hidden="true" />,
  backup: <Database aria-hidden="true" />,
  audit: <History aria-hidden="true" />,
};

/** Design 13: the Settings hub, with the sections on the side. */
export function SettingsPage() {
  const { t } = useTranslation('settings');
  const can = useCan();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <>
      <PageHeader title={t('hub.title')} subtitle={t('hub.subtitle')} />
      <div className={styles.hub}>
        <Card as="nav" rise padding="compact" aria-label={t('hub.label')} className={styles.sub}>
          <div className={styles.subList}>
            {SECTIONS.map((section) => {
              const allowed = isAllowed(section, can);
              const label = t(`hub.${section.id}`);
              return (
                <div key={section.id}>
                  {section.dividerBefore && <hr />}
                  {allowed ? (
                    <Link
                      to={`/settings/${section.id}` as '/settings/users'}
                      aria-current={path === `/settings/${section.id}` ? 'page' : undefined}
                    >
                      <Tile>{ICONS[section.id]}</Tile>
                      <span>{label}</span>
                    </Link>
                  ) : (
                    <span
                      className={styles.later}
                      aria-disabled="true"
                      title={section.permissions ? undefined : t('hub.comingLater')}
                    >
                      <Tile>{ICONS[section.id]}</Tile>
                      <span>{label}</span>
                      {!section.permissions && (
                        <span className={styles.soon}>{t('hub.comingLater')}</span>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
        <div className={cx(styles.panel)}>
          <Outlet />
        </div>
      </div>
    </>
  );
}

/** /settings → the first section this person may open. */
export function SettingsIndex() {
  const can = useCan();
  const first = allowedSections(can)[0];
  if (!first) return <NoAccess />;
  return <Navigate to={`/settings/${first.id}` as '/settings/users'} replace />;
}
