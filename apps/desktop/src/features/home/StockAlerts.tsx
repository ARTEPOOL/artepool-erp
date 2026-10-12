/**
 * Dashboard stock alerts (M3-T10): items at or below their reorder level, items with defective
 * stock, and oversells waiting for the storekeeper's review. Each tile is a link to where the
 * work is done and appears only when its count is above zero and the person may open it.
 */
import type { CSSProperties, ReactNode } from 'react';
import { ChevronRight, PackageX, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { cx, iconClass, Tile, type Tone } from '../../ui';
import { useCan } from '../auth/context';
import { useStockSummary } from '../masterdata/refs';
import styles from './home.module.css';

interface Alert {
  id: 'toReorder' | 'defective' | 'reviews';
  count: number;
  to: '/items' | '/stock/reviews';
  tone: Tone;
  icon: ReactNode;
}

export function StockAlerts() {
  const { t } = useTranslation('settings');
  const can = useCan();
  const summary = useStockSummary();
  if (!can('items.view') || !summary.data) return null;
  const data = summary.data;
  const alerts: Alert[] = [
    {
      id: 'toReorder' as const,
      count: data.toReorder,
      to: '/items' as const,
      tone: 'warn' as const,
      icon: <TriangleAlert aria-hidden="true" />,
    },
    {
      id: 'defective' as const,
      count: data.defectiveItems,
      to: '/items' as const,
      tone: 'danger' as const,
      icon: <PackageX aria-hidden="true" />,
    },
    ...(can('stock.oversell_review')
      ? [
          {
            id: 'reviews' as const,
            count: data.pendingReviews,
            to: '/stock/reviews' as const,
            tone: 'info' as const,
            icon: <ShieldAlert aria-hidden="true" />,
          },
        ]
      : []),
  ].filter((alert) => alert.count > 0);
  if (alerts.length === 0) return null;

  return (
    <section className={styles.alerts} aria-label={t('home.stock.title')}>
      {alerts.map((alert, index) => (
        <Link
          key={alert.id}
          to={alert.to}
          data-testid={`stock-alert-${alert.id}`}
          className={cx(styles.alert, 'rise')}
          style={{ '--i': index + 2 } as CSSProperties}
        >
          <Tile tone={alert.tone}>{alert.icon}</Tile>
          <span className={styles.alertText}>
            <span className={styles.alertLabel}>{t(`home.stock.${alert.id}`)}</span>
            <b>
              <bdi>{alert.count}</bdi>
            </b>
          </span>
          <span className={styles.alertOpen}>
            {t('home.stock.open')}
            <ChevronRight className={cx(iconClass.sm, 'flip-rtl')} aria-hidden="true" />
          </span>
        </Link>
      ))}
    </section>
  );
}
