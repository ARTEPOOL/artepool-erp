import type { ReactNode } from 'react';
import {
  CheckCircle2,
  FileText,
  LayoutGrid,
  LineChart,
  Lock,
  LogOut,
  Package,
  Settings,
  ShoppingCart,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useAuthController, useAuthState, useCan, useDisplayName } from '../features/auth/context';
import { canSeeSettings } from '../features/settings/sections';
import { ActionMenu, Avatar, Brand, Chip, iconClass } from '../ui';
import styles from './Shell.module.css';
import { LanguageSwitch, ThemeToggle } from './TopTools';

/** Sections that arrive in later milestones: shown, greyed, so the layout matches the design. */
const LATER: { key: string; icon: ReactNode }[] = [
  { key: 'pos', icon: <ShoppingCart aria-hidden="true" /> },
  { key: 'invoices', icon: <FileText aria-hidden="true" /> },
  { key: 'items', icon: <Package aria-hidden="true" /> },
  { key: 'customers', icon: <Users aria-hidden="true" /> },
  { key: 'shifts', icon: <Wallet aria-hidden="true" /> },
  { key: 'reports', icon: <LineChart aria-hidden="true" /> },
];

/** The app frame (design 02–14): sidebar, top bar with switches and the account menu. */
export function Shell() {
  const { t } = useTranslation('settings');
  const controller = useAuthController();
  const { user, server } = useAuthState();
  const can = useCan();
  const nameOf = useDisplayName();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const inSettings = path.startsWith('/settings');
  const name = user ? nameOf(user) : '';

  return (
    <div className={styles.shell}>
      <aside className={styles.side}>
        <Brand className={styles.brand}>{t('shell:brand')}</Brand>
        <nav className={styles.nav} aria-label={t('nav.label')}>
          <Link to="/" aria-current={path === '/' ? 'page' : undefined}>
            <LayoutGrid aria-hidden="true" />
            <span>{t('nav.dashboard')}</span>
          </Link>
          {LATER.map((item) => (
            <span
              key={item.key}
              className={styles.later}
              aria-disabled="true"
              title={t('nav.comingLater')}
            >
              {item.icon}
              <span>{t(`nav.${item.key}`)}</span>
            </span>
          ))}
          {canSeeSettings(can) && (
            <Link to="/settings" aria-current={inSettings ? 'page' : undefined}>
              <Settings aria-hidden="true" />
              <span>{t('nav.settings')}</span>
            </Link>
          )}
        </nav>
        <div className={styles.sideFoot}>
          {server === 'down' || server === 'untrusted' ? (
            <Chip tone="danger" icon={<XCircle aria-hidden="true" />}>
              {t('shell:server.unreachable')}
            </Chip>
          ) : (
            <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
              {t('shell:server.connectedShort')}
            </Chip>
          )}
        </div>
      </aside>
      <div className={styles.main}>
        <header className={styles.top}>
          <span className={styles.crumb}>
            {inSettings ? t('nav.settings') : t('nav.dashboard')}
          </span>
          <div className={styles.user}>
            <LanguageSwitch />
            <ThemeToggle />
            <ActionMenu
              label={t('user.menu')}
              trigger={
                <>
                  <Avatar name={name} />
                  <span className={styles.userText}>
                    <strong>{name}</strong>
                    <bdi className={styles.role}>{user?.username}</bdi>
                  </span>
                </>
              }
              actions={[
                {
                  id: 'lock',
                  label: t('user.lock'),
                  icon: <Lock className={iconClass.sm} aria-hidden="true" />,
                  onAction: () => void controller.lock(),
                },
                {
                  id: 'signOut',
                  label: t('user.signOut'),
                  icon: <LogOut className={iconClass.sm} aria-hidden="true" />,
                  onAction: () => void controller.signOut(),
                },
              ]}
            />
          </div>
        </header>
        <main className={styles.page}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
