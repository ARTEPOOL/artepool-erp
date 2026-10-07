import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Database,
  Download,
  History,
  KeyRound,
  Lock,
  Monitor,
  RefreshCw,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  User,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AuditEntry, AuditPage, ChainStatus, UsersResponse } from '@artepool/shared/contracts';
import { addDays, dubaiDay, formatDate, formatDateTime, formatTime } from '../../../lib/format';
import {
  Alert,
  Button,
  Card,
  Chip,
  cx,
  iconClass,
  Note,
  SearchField,
  SelectField,
  tableClasses,
  Tile,
  useToast,
} from '../../../ui';
import { useCan, useDisplayName, useErrorText } from '../../auth/context';
import { KEYS, useApi } from '../api';
import { CardHead, NoAccess, PanelHeader, settingsClasses as styles } from '../parts';
import {
  actionArea,
  actionLabel,
  actionTone,
  changedFields,
  fieldLabel,
  valueText,
} from './labels';

const AREA_ICON: Record<ReturnType<typeof actionArea>, ReactNode> = {
  'sign-in': <KeyRound aria-hidden="true" />,
  user: <User aria-hidden="true" />,
  role: <Shield aria-hidden="true" />,
  device: <Monitor aria-hidden="true" />,
  audit: <History aria-hidden="true" />,
  settings: <Settings aria-hidden="true" />,
  data: <Database aria-hidden="true" />,
};

type DateFilter = 'today' | 'yesterday' | 'all';
type KindFilter = 'all' | 'security' | 'settings' | 'data';

const PAGE = 50;

/** The search waits for a pause in typing before asking the server. */
function useDebounced(value: string, ms = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Design 13: Settings → Audit log (read only). */
export function AuditPanel() {
  const { t, i18n } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [userId, setUserId] = useState('');
  const [dates, setDates] = useState<DateFilter>('today');
  const [kind, setKind] = useState<KindFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'verify' | 'export' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useDebounced(search.trim());

  const params = useMemo(() => {
    const p = new URLSearchParams();
    // "Today" is the Al Ain calendar day; the server filters on its own stored times.
    const today = dubaiDay();
    if (dates !== 'all') {
      const day = dates === 'today' ? today : addDays(today, -1);
      p.set('from', day);
      p.set('to', day);
    }
    if (kind !== 'all') p.set('kind', kind);
    if (userId) p.set('userId', userId);
    if (q) p.set('q', q);
    return p;
  }, [dates, kind, userId, q]);

  const allowed = can('audit.view');
  const entries = useInfiniteQuery({
    queryKey: [...KEYS.audit, params.toString()],
    enabled: allowed,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      p.set('limit', String(PAGE));
      if (pageParam) p.set('before', pageParam);
      return api.get<AuditPage>(`/api/v1/audit?${p.toString()}`, { background: true });
    },
    getNextPageParam: (last) => last.nextBefore,
  });
  const chain = useQuery({
    queryKey: KEYS.chain,
    enabled: allowed,
    queryFn: () => api.get<ChainStatus>('/api/v1/audit/chain', { background: true }),
  });
  const users = useQuery({
    queryKey: KEYS.users,
    enabled: allowed && can('users.view'),
    queryFn: () => api.get<UsersResponse>('/api/v1/users'),
  });

  const list = useMemo(() => entries.data?.pages.flatMap((p) => p.entries) ?? [], [entries.data]);
  useEffect(() => {
    if (list.length > 0 && !list.some((e) => e.id === selectedId)) setSelectedId(list[0]!.id);
  }, [list, selectedId]);

  if (!allowed) return <NoAccess />;
  const selected = list.find((e) => e.id === selectedId) ?? null;
  const today = dubaiDay();

  const verify = async () => {
    setBusy('verify');
    setError(null);
    try {
      const status = await api.post<ChainStatus>('/api/v1/audit/verify');
      await chain.refetch();
      if (status.lastCheck?.ok) {
        toast(t('audit.verifiedOk', { count: status.lastCheck.rowsChecked }));
      } else {
        toast(t('audit.verifiedBad'), 'warn');
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async () => {
    setBusy('export');
    setError(null);
    try {
      const csv = await api.get<string>(`/api/v1/audit/export?${params.toString()}`);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-log-${today}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast(t('audit.exported'));
      void entries.refetch();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  };

  const status = chain.data;
  const check = status?.lastCheck ?? null;
  const userName = (entry: AuditEntry) => (entry.user ? nameOf(entry.user) : t('audit.system'));
  const onRowKey = (event: KeyboardEvent, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedId(id);
    }
  };

  return (
    <>
      <PanelHeader
        title={t('audit.title')}
        subtitle={t('audit.subtitle')}
        tools={
          can('audit.export') && (
            <Button
              busy={busy === 'export'}
              isDisabled={busy !== null}
              onPress={() => void exportCsv()}
            >
              <Download className={iconClass.sm} aria-hidden="true" />
              {t('audit.export')}
            </Button>
          )
        }
      />
      <Card rise index={1}>
        <div className={styles.hashrow}>
          <Tile tone={check && !check.ok ? 'danger' : check ? 'ok' : 'neutral'}>
            {check && !check.ok ? (
              <ShieldAlert aria-hidden="true" />
            ) : (
              <ShieldCheck aria-hidden="true" />
            )}
          </Tile>
          <div className={styles.hashText}>
            <b>
              {!check
                ? t('audit.chainUnknown')
                : check.ok
                  ? t('audit.chainOk')
                  : t('audit.chainBad', { seq: check.firstBadSeq ?? '?' })}
            </b>
            {status && (
              <span className={tableClasses.sub}>
                {check
                  ? t('audit.chainInfo', {
                      count: status.lastSeq,
                      when: formatDateTime(check.at),
                    })
                  : t('audit.chainInfoNever', { count: status.lastSeq })}
              </span>
            )}
          </div>
          {can('audit.verify') && (
            <Button
              busy={busy === 'verify'}
              isDisabled={busy !== null}
              onPress={() => void verify()}
            >
              <RefreshCw className={iconClass.sm} aria-hidden="true" />
              {busy === 'verify' ? t('audit.verifying') : t('audit.verify')}
            </Button>
          )}
        </div>
      </Card>
      {error && <Alert>{error}</Alert>}
      <div className={cx(styles.filters, 'rise')}>
        <SearchField
          label={t('audit.search')}
          value={search}
          onChange={setSearch}
          className={styles.search}
        />
        {can('users.view') && (
          <SelectField
            id="audit-user"
            label={t('audit.colUser')}
            value={userId}
            options={[
              { value: '', label: t('audit.allUsers') },
              ...(users.data?.users ?? []).map((u) => ({ value: u.id, label: nameOf(u) })),
            ]}
            onChange={setUserId}
          />
        )}
        <SelectField
          id="audit-dates"
          label={t('audit.colTime')}
          value={dates}
          options={(['today', 'yesterday', 'all'] as const).map((value) => ({
            value,
            label: t(`audit.dates.${value}`),
          }))}
          onChange={(value) => setDates(value as DateFilter)}
        />
        <SelectField
          id="audit-kind"
          label={t('audit.colAction')}
          value={kind}
          options={(['all', 'security', 'settings', 'data'] as const).map((value) => ({
            value,
            label: t(`audit.kinds.${value}`),
          }))}
          onChange={(value) => setKind(value as KindFilter)}
        />
      </div>
      <div className={styles.two}>
        <Card rise index={3} padding="table">
          <table className={cx(tableClasses.table, tableClasses.selectable)}>
            <thead>
              <tr>
                <th>{t('audit.colTime')}</th>
                <th>{t('audit.colAction')}</th>
                <th>{t('audit.colUser')}</th>
                <th>{t('audit.colDevice')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((entry) => {
                const tone = actionTone(entry);
                return (
                  <tr
                    key={entry.id}
                    tabIndex={0}
                    aria-selected={entry.id === selectedId}
                    className={cx(entry.id === selectedId && tableClasses.sel)}
                    onClick={() => setSelectedId(entry.id)}
                    onKeyDown={(event) => onRowKey(event, entry.id)}
                  >
                    <td>
                      <bdi>{formatTime(entry.at)}</bdi>
                      {dubaiDay(entry.at) !== today && (
                        <span className={tableClasses.sub}>
                          <bdi>{formatDate(entry.at)}</bdi>
                        </span>
                      )}
                    </td>
                    <td>
                      <div className={tableClasses.who}>
                        <Tile tone={tone === 'neutral' ? 'neutral' : tone}>
                          {tone === 'danger' ? (
                            <Lock aria-hidden="true" />
                          ) : (
                            AREA_ICON[actionArea(entry)]
                          )}
                        </Tile>
                        <span>
                          <b>{actionLabel(entry, t, i18n)}</b>
                          {(entry.entityLabel ?? entry.reason) && (
                            <span className={tableClasses.sub}>
                              <bdi>{entry.entityLabel ?? entry.reason}</bdi>
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td>{userName(entry)}</td>
                    <td>
                      <bdi>{entry.device?.code ?? '—'}</bdi>
                    </td>
                  </tr>
                );
              })}
              {!entries.isLoading && list.length === 0 && (
                <tr className={tableClasses.empty}>
                  <td colSpan={4}>{t('audit.empty')}</td>
                </tr>
              )}
              {entries.isLoading && (
                <tr className={tableClasses.empty}>
                  <td colSpan={4}>{t('common.loading')}</td>
                </tr>
              )}
            </tbody>
          </table>
          {entries.hasNextPage && (
            <div className={styles.savebar}>
              <span />
              <Button
                busy={entries.isFetchingNextPage}
                isDisabled={entries.isFetchingNextPage}
                onPress={() => void entries.fetchNextPage()}
              >
                {t('common.loadMore')}
              </Button>
            </div>
          )}
        </Card>
        <Card rise index={4}>
          {selected ? (
            <EntryDetails entry={selected} userName={userName(selected)} />
          ) : (
            <Note>{t('audit.select')}</Note>
          )}
        </Card>
      </div>
    </>
  );
}

function EntryDetails({ entry, userName }: { entry: AuditEntry; userName: string }) {
  const { t, i18n } = useTranslation('settings');
  const changes = changedFields(entry);
  return (
    <>
      <CardHead title={t('audit.details')}>
        <Chip>
          <bdi>#{entry.seq ?? entry.id}</bdi>
        </Chip>
      </CardHead>
      <dl className={styles.dl}>
        <div>
          <dt>{t('audit.action')}</dt>
          <dd>{actionLabel(entry, t, i18n)}</dd>
        </div>
        <div>
          <dt>{t('audit.user')}</dt>
          <dd>{userName}</dd>
        </div>
        <div>
          <dt>{t('audit.device')}</dt>
          <dd>
            <bdi>{entry.device?.code ?? '—'}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('audit.serverTime')}</dt>
          <dd>
            <bdi>{formatDateTime(entry.at)}</bdi>
          </dd>
        </div>
        {entry.reason && (
          <div>
            <dt>{t('audit.reason')}</dt>
            <dd>
              <bdi>{entry.reason}</bdi>
            </dd>
          </div>
        )}
      </dl>
      {changes.length > 0 && entry.oldValues === null ? (
        <dl className={styles.dl}>
          {changes.map((row) => (
            <div key={row.field}>
              <dt>{fieldLabel(row.field, t, i18n)}</dt>
              <dd>
                <bdi>{valueText(row.after)}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      ) : changes.length > 0 ? (
        <div className={styles.diff}>
          <span className={styles.h}>{t('audit.field')}</span>
          <span className={styles.h}>{t('audit.before')}</span>
          <span className={styles.h}>{t('audit.after')}</span>
          {changes.map((row) => (
            <FieldRow key={row.field} label={fieldLabel(row.field, t, i18n)} row={row} />
          ))}
        </div>
      ) : (
        <Note>{t('audit.noChanges')}</Note>
      )}
      <Note className={styles.tableNote}>{t('audit.readOnly')}</Note>
    </>
  );
}

function FieldRow({ label, row }: { label: string; row: { before: unknown; after: unknown } }) {
  return (
    <>
      <span>{label}</span>
      <span className={styles.old}>
        <bdi>{valueText(row.before)}</bdi>
      </span>
      <span className={styles.new}>
        <bdi>{valueText(row.after)}</bdi>
      </span>
    </>
  );
}
