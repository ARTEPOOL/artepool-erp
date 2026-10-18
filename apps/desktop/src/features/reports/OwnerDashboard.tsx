/**
 * The owner dashboard (decisions 0039, 0081): sales, VAT and profit for a period with the change
 * from the period before, a day-by-day chart, where the sales came from, the best items and
 * customers, and right now: cash in drawers and safe, what customers owe, and stock to reorder.
 * Owner only; the server refuses everyone else.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import { BadgePercent, Banknote, LineChart, Receipt, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { formatQuantity } from '@artepool/shared';
import type {
  DashboardFigures,
  DashboardPeriod,
  DashboardResponse,
} from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { dubaiDay } from '../../lib/format';
import {
  Alert,
  Card,
  CardHeader,
  cx,
  Kpi,
  Kpis,
  Note,
  PageHeader,
  Segmented,
  tableClasses,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { DateField } from '../invoices/parts';
import { money } from '../masterdata/format';
import styles from './dashboard.module.css';

const big = (text: string) => BigInt(text);
const qty = (milli: string) => formatQuantity(BigInt(milli)).replace(/\.?0+$/, '');
const shortDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
/** 18/10/2026, kept left to right inside Arabic text. */
const longDay = (iso: string) =>
  `\u2066${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}\u2069`;

/** "+12.5%" against the period before, or nothing when there is nothing to compare with. */
function percentChange(now: string, before: string): number | null {
  const b = big(before);
  if (b === 0n) return null;
  return Number(((big(now) - b) * 1000n) / (b < 0n ? -b : b)) / 10;
}

export function OwnerDashboard() {
  const { t, i18n } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const errorText = useErrorText();
  const ar = i18n.language !== 'en';
  const nameOf = (x: { nameAr: string; nameEn: string }) => (ar ? x.nameAr : x.nameEn);
  const [period, setPeriod] = useState<DashboardPeriod>('today');
  const [from, setFrom] = useState(dubaiDay());
  const [to, setTo] = useState(dubaiDay());
  const allowed = can('reports.owner_dashboard');
  const params = new URLSearchParams({ period });
  if (period === 'custom') {
    params.set('from', from);
    params.set('to', to);
  }
  const data = useQuery({
    queryKey: ['reports', 'owner-dashboard', period, period === 'custom' ? `${from}..${to}` : ''],
    queryFn: () =>
      api.get<DashboardResponse>(`/api/v1/reports/owner-dashboard?${params.toString()}`),
    enabled: allowed && (period !== 'custom' || (from !== '' && to !== '' && from <= to)),
  });
  if (!allowed) return <Note>{t('dashboard.noAccess')}</Note>;
  const d = data.data;

  const versus = (field: keyof DashboardFigures) => {
    if (!d || field === 'documents') return null;
    const change = percentChange(d.current[field], d.previous[field]);
    return (
      <span
        className={cx(styles.change, change !== null && (change >= 0 ? styles.up : styles.down))}
      >
        {change === null
          ? t('dashboard.noComparison')
          : t('dashboard.vsBefore', { change: `${change >= 0 ? '+' : ''}${change.toFixed(1)}%` })}
      </span>
    );
  };
  const figure = (field: keyof DashboardFigures, extra?: ReactNode) =>
    d ? (
      <>
        <bdi>
          {money(big(d.current[field] as string))} <small>{t('dashboard.aed')}</small>
        </bdi>
        {extra}
        {versus(field)}
      </>
    ) : (
      '—'
    );
  const margin =
    d && big(d.current.netFils) !== 0n
      ? `${(Number((big(d.current.profitFils) * 1000n) / big(d.current.netFils)) / 10).toFixed(1)}%`
      : null;

  const maxDaily = d
    ? d.daily.reduce((m, x) => (big(x.totalFils) > m ? big(x.totalFils) : m), 0n)
    : 0n;

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={
          d
            ? t('dashboard.range', { from: longDay(d.from), to: longDay(d.to) })
            : t('dashboard.subtitle')
        }
        tools={
          <div className={styles.tools}>
            <Segmented<DashboardPeriod>
              label={t('dashboard.period')}
              value={period}
              onChange={setPeriod}
              options={(['today', 'week', 'month', 'year', 'custom'] as const).map((p) => ({
                value: p,
                label: t(`dashboard.periods.${p}`),
              }))}
            />
            {period === 'custom' && (
              <>
                <DateField label={t('dashboard.from')} value={from} onChange={setFrom} />
                <DateField label={t('dashboard.to')} value={to} onChange={setTo} />
              </>
            )}
          </div>
        }
      />
      {data.error && <Alert>{errorText(data.error)}</Alert>}

      <Kpis>
        <Kpi
          index={1}
          icon={<Receipt aria-hidden="true" />}
          label={t('dashboard.total')}
          value={figure('totalFils')}
        />
        <Kpi
          index={2}
          icon={<Banknote aria-hidden="true" />}
          label={t('dashboard.net')}
          value={figure('netFils')}
        />
        <Kpi
          index={3}
          icon={<BadgePercent aria-hidden="true" />}
          tone="warn"
          label={t('dashboard.vat')}
          value={figure('vatFils')}
        />
        <Kpi
          index={4}
          icon={<LineChart aria-hidden="true" />}
          tone="ok"
          label={t('dashboard.profit')}
          value={figure(
            'profitFils',
            margin && <span className={styles.change}>{t('dashboard.margin', { margin })}</span>,
          )}
        />
      </Kpis>
      <Note>{t('dashboard.vatNote')}</Note>

      {d && (
        <>
          <Card rise index={5} className={styles.section}>
            <CardHeader title={t('dashboard.daily')}>
              <span className={styles.muted}>
                {t('dashboard.documents', { n: d.current.documents })}
              </span>
            </CardHeader>
            {d.daily.length === 0 ? (
              <Note>{t('dashboard.noSales')}</Note>
            ) : (
              <div className={styles.chart} role="list">
                {d.daily.map((x) => {
                  const value = big(x.totalFils);
                  const h = maxDaily > 0n && value > 0n ? Number((value * 100n) / maxDaily) : 2;
                  return (
                    <div
                      key={x.date}
                      role="listitem"
                      className={styles.col}
                      title={`${x.date}: ${money(value)} · ${t('dashboard.profit')} ${money(big(x.profitFils))}`}
                    >
                      <span
                        className={cx(styles.bar, value < 0n && styles.barNegative)}
                        style={{ '--h': `${h}%` } as CSSProperties}
                      />
                      <bdi className={styles.day}>{shortDay(x.date)}</bdi>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <div className={styles.grid}>
            <Card rise index={6}>
              <CardHeader title={t('dashboard.split')} />
              <div className={styles.rows}>
                <div>
                  <span>{t('dashboard.pos')}</span>
                  <bdi>{money(big(d.byChannel.posFils))}</bdi>
                </div>
                <div>
                  <span>{t('dashboard.a4')}</span>
                  <bdi>{money(big(d.byChannel.a4Fils))}</bdi>
                </div>
                {d.byMethod.map((m) => (
                  <div key={m.methodId}>
                    <span>{t('dashboard.received', { method: nameOf(m) })}</span>
                    <bdi>{money(big(m.amountFils))}</bdi>
                  </div>
                ))}
                <div>
                  <span>{t('dashboard.unpaid')}</span>
                  <bdi className={big(d.unpaidFils) > 0n ? styles.negative : undefined}>
                    {money(big(d.unpaidFils))}
                  </bdi>
                </div>
              </div>
            </Card>

            <Card rise index={7} padding="table">
              <CardHeader title={t('dashboard.byCashier')} />
              <table className={tableClasses.table}>
                <thead>
                  <tr>
                    <th>{t('dashboard.cashier')}</th>
                    <th className={tableClasses.num}>{t('dashboard.docs')}</th>
                    <th className={tableClasses.num}>{t('dashboard.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byCashier.map((c) => (
                    <tr key={c.userId}>
                      <td>{nameOf(c)}</td>
                      <td className={tableClasses.num}>
                        <bdi>{c.documents}</bdi>
                      </td>
                      <td className={tableClasses.num}>
                        <bdi>{money(big(c.totalFils))}</bdi>
                      </td>
                    </tr>
                  ))}
                  {d.byCashier.length === 0 && (
                    <tr className={tableClasses.empty}>
                      <td colSpan={3}>{t('dashboard.noSales')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>

            <Card rise index={8} padding="table">
              <CardHeader title={t('dashboard.topItems')} />
              <table className={tableClasses.table}>
                <thead>
                  <tr>
                    <th>{t('dashboard.item')}</th>
                    <th className={tableClasses.num}>{t('dashboard.qty')}</th>
                    <th className={tableClasses.num}>{t('dashboard.net')}</th>
                    <th className={tableClasses.num}>{t('dashboard.profit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.topItems.map((i) => (
                    <tr key={i.itemId}>
                      <td>
                        {nameOf(i)}
                        <bdi className={tableClasses.sub}>{i.code}</bdi>
                      </td>
                      <td className={tableClasses.num}>
                        <bdi>{qty(i.quantityMilli)}</bdi>
                      </td>
                      <td className={tableClasses.num}>
                        <bdi>{money(big(i.netFils))}</bdi>
                      </td>
                      <td className={tableClasses.num}>
                        <bdi className={big(i.profitFils) < 0n ? styles.negative : undefined}>
                          {money(big(i.profitFils))}
                        </bdi>
                      </td>
                    </tr>
                  ))}
                  {d.topItems.length === 0 && (
                    <tr className={tableClasses.empty}>
                      <td colSpan={4}>{t('dashboard.noSales')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>

            <Card rise index={9}>
              <CardHeader title={t('dashboard.topCustomers')} />
              <div className={styles.rows}>
                {d.topCustomers.map((c) => (
                  <div key={c.customerId}>
                    <span>{c.name}</span>
                    <bdi>{money(big(c.totalFils))}</bdi>
                  </div>
                ))}
                {d.topCustomers.length === 0 && <Note>{t('dashboard.noCustomers')}</Note>}
              </div>
            </Card>
          </div>

          <h2 className={styles.section}>{t('dashboard.now')}</h2>
          <Kpis>
            <Kpi
              index={10}
              icon={<Wallet aria-hidden="true" />}
              label={t('dashboard.drawers', { n: d.cash.openShifts.length })}
              value={
                <bdi>
                  {money(big(d.cash.drawersFils))} <small>{t('dashboard.aed')}</small>
                </bdi>
              }
            />
            <Kpi
              index={11}
              icon={<Banknote aria-hidden="true" />}
              label={t('dashboard.safe')}
              value={
                <bdi>
                  {money(big(d.cash.safeFils))} <small>{t('dashboard.aed')}</small>
                </bdi>
              }
            />
            <Kpi
              index={12}
              icon={<Receipt aria-hidden="true" />}
              tone={big(d.receivables.overdueFils) > 0n ? 'warn' : undefined}
              label={t('dashboard.owed')}
              value={
                <>
                  <bdi>
                    {money(big(d.receivables.totalFils))} <small>{t('dashboard.aed')}</small>
                  </bdi>
                  <span className={styles.change}>
                    {t('dashboard.overdue', { amount: money(big(d.receivables.overdueFils)) })}
                  </span>
                </>
              }
            />
            <Kpi
              index={13}
              icon={<LineChart aria-hidden="true" />}
              tone={d.stock.toReorder > 0 ? 'warn' : undefined}
              label={t('dashboard.stockValue')}
              value={
                <>
                  <bdi>
                    {money(big(d.stock.valueFils))} <small>{t('dashboard.aed')}</small>
                  </bdi>
                  <span className={styles.change}>
                    {t('dashboard.toReorder', { n: d.stock.toReorder })}
                  </span>
                </>
              }
            />
          </Kpis>

          <div className={styles.grid}>
            <Card rise index={14}>
              <CardHeader title={t('dashboard.openShifts')}>
                <span className={styles.muted}>
                  {t('dashboard.variance', { amount: money(big(d.cash.varianceFils)) })}
                </span>
              </CardHeader>
              <div className={styles.rows}>
                {d.cash.openShifts.map((s) => (
                  <div key={s.shiftId}>
                    <span>
                      <bdi>{s.registerCode}</bdi> · {nameOf(s)} · <bdi>{s.shiftNumber}</bdi>
                    </span>
                    <bdi>{money(big(s.expectedFils))}</bdi>
                  </div>
                ))}
                {d.cash.openShifts.length === 0 && <Note>{t('dashboard.noShifts')}</Note>}
              </div>
            </Card>

            <Card rise index={15} padding="table">
              <CardHeader title={t('dashboard.debtors')} />
              <table className={tableClasses.table}>
                <thead>
                  <tr>
                    <th>{t('dashboard.customer')}</th>
                    <th className={tableClasses.num}>{t('dashboard.balance')}</th>
                    <th className={tableClasses.num}>{t('dashboard.overdueCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.receivables.customers.map((c) => (
                    <tr key={c.customerId}>
                      <td>{c.name}</td>
                      <td className={tableClasses.num}>
                        <bdi>{money(big(c.balanceFils))}</bdi>
                      </td>
                      <td className={tableClasses.num}>
                        <bdi className={big(c.overdueFils) > 0n ? styles.negative : undefined}>
                          {money(big(c.overdueFils))}
                        </bdi>
                      </td>
                    </tr>
                  ))}
                  {d.receivables.customers.length === 0 && (
                    <tr className={tableClasses.empty}>
                      <td colSpan={3}>{t('dashboard.noDebtors')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>

            <Card rise index={16}>
              <CardHeader title={t('dashboard.reorder')} />
              <div className={styles.rows}>
                {d.stock.items.map((i) => (
                  <div key={i.itemId}>
                    <span>
                      {nameOf(i)} <bdi className={styles.muted}>{i.code}</bdi>
                    </span>
                    <span>
                      {t('dashboard.left', {
                        onHand: qty(i.onHandMilli),
                        level: qty(i.reorderLevelMilli),
                      })}
                    </span>
                  </div>
                ))}
                {d.stock.items.length === 0 && <Note>{t('dashboard.noReorder')}</Note>}
              </div>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
