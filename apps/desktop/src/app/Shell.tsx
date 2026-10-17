import { useState, type ReactNode } from 'react';
import {
  BookOpen,
  CheckCircle2,
  FileSignature,
  FileText,
  KeyRound,
  LayoutGrid,
  LineChart,
  Lock,
  LogOut,
  Package,
  ReceiptText,
  Settings,
  ShoppingCart,
  Truck,
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
import { ApprovalPinDialog } from './ApprovalPinDialog';
import { LanguageSwitch, ThemeToggle } from './TopTools';

type NavItem =
  | {
      key: string;
      icon: ReactNode;
      to:
        | '/invoices'
        | '/quotations'
        | '/receipts'
        | '/items'
        | '/customers'
        | '/suppliers'
        | '/accounting'
        | '/pos'
        | '/shifts';
      permission: string;
    }
  /** Arrives in a later milestone: shown, greyed, so the layout matches the design. */
  | { key: string; icon: ReactNode; later: true };

/** The side menu (design 02; decision 0034): every entry needs its permission. */
const NAV: NavItem[] = [
  { key: 'pos', icon: <ShoppingCart aria-hidden="true" />, to: '/pos', permission: 'pos.sell' },
  // Sales (decision 0045): each section has its own entry.
  {
    key: 'invoices',
    icon: <FileText aria-hidden="true" />,
    to: '/invoices',
    permission: 'invoices.view',
  },
  {
    key: 'quotations',
    icon: <FileSignature aria-hidden="true" />,
    to: '/quotations',
    permission: 'quotations.manage',
  },
  {
    key: 'receipts',
    icon: <ReceiptText aria-hidden="true" />,
    to: '/receipts',
    permission: 'invoices.view',
  },
  { key: 'items', icon: <Package aria-hidden="true" />, to: '/items', permission: 'items.view' },
  {
    key: 'customers',
    icon: <Users aria-hidden="true" />,
    to: '/customers',
    permission: 'customers.view',
  },
  {
    key: 'suppliers',
    icon: <Truck aria-hidden="true" />,
    to: '/suppliers',
    permission: 'suppliers.manage',
  },
  { key: 'shifts', icon: <Wallet aria-hidden="true" />, to: '/shifts', permission: 'shifts.open' },
  { key: 'reports', icon: <LineChart aria-hidden="true" />, later: true },
  {
    key: 'accounting',
    icon: <BookOpen aria-hidden="true" />,
    to: '/accounting',
    permission: 'ledger.view',
  },
];

/** The menu entry a page belongs to (shown at the top of the page). */
function crumbOf(path: string): string {
  if (path.startsWith('/settings')) return 'settings';
  if (path.startsWith('/stock')) return 'items';
  if (path.startsWith('/pos')) return 'pos';
  const found = NAV.find((item) => 'to' in item && path.startsWith(item.to));
  return found?.key ?? 'dashboard';
}

/** The app frame (design 02–14): sidebar, top bar with switches and the account menu. */
export function Shell() {
  const { t } = useTranslation('settings');
  const controller = useAuthController();
  const [settingPin, setSettingPin] = useState(false);
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
          {NAV.map((item) =>
            'later' in item ? (
              <span
                key={item.key}
                className={styles.later}
                aria-disabled="true"
                title={t('nav.comingLater')}
              >
                {item.icon}
                <span>{t(`nav.${item.key}`)}</span>
              </span>
            ) : (
              can(item.permission) && (
                <Link
                  key={item.key}
                  to={item.to}
                  aria-current={crumbOf(path) === item.key ? 'page' : undefined}
                >
                  {item.icon}
                  <span>{t(`nav.${item.key}`)}</span>
                </Link>
              )
            ),
          )}
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
          <span className={styles.crumb}>{t(`nav.${crumbOf(path)}`)}</span>
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
                // Supervisors who sign in with a password choose the PIN they approve with.
                ...(user?.signInMethod !== 'pin'
                  ? [
                      {
                        id: 'approvalPin',
                        label: t('approvalPin.menu'),
                        icon: <KeyRound className={iconClass.sm} aria-hidden="true" />,
                        onAction: () => setSettingPin(true),
                      },
                    ]
                  : []),
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
        {settingPin && <ApprovalPinDialog onClose={() => setSettingPin(false)} />}
      </div>
    </div>
  );
}
