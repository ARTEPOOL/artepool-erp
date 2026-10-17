import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRightLeft,
  Ban,
  CheckCircle2,
  Monitor,
  Pencil,
  RefreshCw,
  Server,
  ShieldCheck,
  ShieldOff,
  ShoppingCart,
  Timer,
  Warehouse,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type {
  DeviceKind,
  DeviceListItem,
  DevicesResponse,
  EnrollmentCodeResponse,
  WarehouseItem,
} from '@artepool/shared/contracts';
import { formatDate, formatDateTime, formatTime } from '../../../lib/format';
import {
  Alert,
  Button,
  Card,
  Chip,
  cx,
  Dialog,
  DialogFooter,
  iconClass,
  Note,
  Segmented,
  SelectField,
  tableClasses,
  TextField,
  Tile,
  useToast,
} from '../../../ui';
import { useCan, useDisplayName, useErrorText } from '../../auth/context';
import { localName } from '../../masterdata/refs';
import { KEYS, useApi, useSave } from '../api';
import { useWarehouses } from '../lists/queries';
import { CardHead, NoAccess, PanelHeader, settingsClasses as styles } from '../parts';
import { ReasonDialog } from '../users/dialogs';
import deviceStyles from './devices.module.css';
import { ReceiptPrinterCard } from './ReceiptPrinter';

const KIND_ICON: Record<DeviceKind, ReactNode> = {
  pos: <ShoppingCart aria-hidden="true" />,
  office: <Monitor aria-hidden="true" />,
  warehouse: <Warehouse aria-hidden="true" />,
  server: <Server aria-hidden="true" />,
};

/** Minutes:seconds left until `expiresAt`, ticking every second; null once expired. */
function useCountdown(expiresAt: string | null): string | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  if (left === 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

/** Design 13: Settings → Devices & printers (decisions 0024, 0026, 0027). */
export function DevicesPanel() {
  const { t } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const nameOf = useDisplayName();
  const toast = useToast();
  const errorText = useErrorText();
  const devices = useQuery({
    queryKey: KEYS.devices,
    queryFn: () => api.get<DevicesResponse>('/api/v1/devices'),
    enabled: can('system.devices.manage'),
  });
  const [shownCode, setShownCode] = useState<EnrollmentCodeResponse | null>(null);
  const [revoking, setRevoking] = useState<DeviceListItem | null>(null);
  const [moving, setMoving] = useState<DeviceListItem | null>(null);
  const [editing, setEditing] = useState<DeviceListItem | null>(null);
  const [untrusting, setUntrusting] = useState<DeviceListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warehouseError, setWarehouseError] = useState<string | null>(null);
  const newCode = useSave(
    (client, _: null, key) =>
      client.post<EnrollmentCodeResponse>(
        '/api/v1/devices/enrollment-codes',
        {},
        {
          idempotencyKey: key,
        },
      ),
    {
      invalidate: [KEYS.devices],
      onSuccess: (result) => {
        setShownCode(result);
        toast(t('devices.codeCreated'));
      },
    },
  );
  const countdown = useCountdown(shownCode?.code ? shownCode.expiresAt : null);
  // The warehouse per PC only matters with more than one active warehouse; without the right
  // to read the warehouses the field stays hidden (the server checks the save again).
  const warehouses = useWarehouses(can('system.devices.manage') && can('warehouses.manage'));
  const activeWarehouses = (warehouses.data ?? []).filter((w) => w.isActive);
  const showWarehouse = activeWarehouses.length > 1;
  const columns = showWarehouse ? 5 : 4;

  if (!can('system.devices.manage')) return <NoAccess />;
  const list = devices.data?.devices ?? [];
  const openCode = devices.data?.openCode ?? null;

  return (
    <>
      <PanelHeader title={t('devices.title')} subtitle={t('devices.subtitle')} />
      <div className={styles.two}>
        <Card rise index={1} padding="table">
          <div className={styles.tblHead}>
            <CardHead title={t('devices.enrolled')} />
          </div>
          <table className={tableClasses.table}>
            <thead>
              <tr>
                <th>{t('devices.colDevice')}</th>
                <th>{t('devices.colStatus')}</th>
                {showWarehouse && <th>{t('devices.colWarehouse')}</th>}
                <th className={tableClasses.num}>{t('devices.colKey')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((device) => {
                const revoked = device.status === 'revoked';
                const fixed = device.isCurrent || device.kind === 'server';
                return (
                  <tr key={device.id} className={cx(revoked && tableClasses.off)}>
                    <td>
                      <div className={tableClasses.who}>
                        <Tile>{KIND_ICON[device.kind]}</Tile>
                        <span>
                          <b>
                            <bdi>{device.code}</bdi>
                          </b>
                          <span className={tableClasses.sub}>
                            <bdi>{device.name}</bdi> · {t(`devices.kinds.${device.kind}`)}
                          </span>
                          {device.lastSeenAt && (
                            <span className={tableClasses.sub}>
                              {t('devices.colSeen')}: <bdi>{formatDateTime(device.lastSeenAt)}</bdi>
                            </span>
                          )}
                          {device.drawer && (
                            <span className={tableClasses.sub}>
                              {device.drawer.openShift
                                ? t('devices.drawerWithShift', {
                                    drawer: device.drawer.code,
                                    shift: device.drawer.openShift.number,
                                    name: nameOf(device.drawer.openShift),
                                  })
                                : t('devices.drawer', { drawer: device.drawer.code })}
                            </span>
                          )}
                          {device.trustedFor.map((person) => (
                            <span
                              key={person.userId}
                              className={cx(tableClasses.sub, styles.trusted)}
                            >
                              <ShieldCheck className={iconClass.sm} aria-hidden="true" />
                              {t('devices.trustedUntil', {
                                name: nameOf(person),
                                date: formatDate(person.expiresAt),
                              })}
                            </span>
                          ))}
                        </span>
                      </div>
                    </td>
                    <td>
                      {revoked ? (
                        <Chip tone="danger" icon={<Ban aria-hidden="true" />}>
                          {t('devices.revoked')}
                        </Chip>
                      ) : (
                        <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
                          {t('devices.active')}
                        </Chip>
                      )}
                      {revoked && device.revokeReason && (
                        <span className={tableClasses.sub}>
                          <bdi>{device.revokeReason}</bdi>
                        </span>
                      )}
                    </td>
                    {showWarehouse && (
                      <td>
                        {revoked ? (
                          '—'
                        ) : (
                          <WarehouseSelect
                            key={`${device.id}-${device.defaultWarehouseId ?? ''}`}
                            device={device}
                            warehouses={warehouses.data ?? []}
                            onError={setWarehouseError}
                          />
                        )}
                      </td>
                    )}
                    <td className={tableClasses.num}>
                      {revoked ? '—' : <bdi>{formatDate(device.keyExpiresAt)}</bdi>}
                    </td>
                    <td className={tableClasses.num}>
                      {revoked && device.drawer && (
                        <Button variant="ghost" onPress={() => setMoving(device)}>
                          <ArrowRightLeft className={iconClass.sm} aria-hidden="true" />
                          {t('devices.moveDrawer')}
                        </Button>
                      )}
                      {!revoked && (
                        <span className={styles.tools}>
                          <Button
                            variant="ghost"
                            aria-label={`${t('devices.edit')} ${device.code}`}
                            onPress={() => setEditing(device)}
                          >
                            <Pencil className={iconClass.sm} aria-hidden="true" />
                          </Button>
                          {device.trustedFor.length > 0 && (
                            <Button variant="ghost" onPress={() => setUntrusting(device)}>
                              <ShieldOff className={iconClass.sm} aria-hidden="true" />
                              {t('devices.endTrust')}
                            </Button>
                          )}
                          {fixed ? (
                            <span className={tableClasses.sub}>
                              {device.isCurrent ? t('devices.thisDevice') : t('devices.server')}
                            </span>
                          ) : (
                            <Button variant="dangerGhost" onPress={() => setRevoking(device)}>
                              <Ban className={iconClass.sm} aria-hidden="true" />
                              {t('devices.revoke')}
                            </Button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {devices.isLoading && (
                <tr className={tableClasses.empty}>
                  <td colSpan={columns}>{t('common.loading')}</td>
                </tr>
              )}
            </tbody>
          </table>
          {warehouseError && <Alert>{warehouseError}</Alert>}
          <Note className={styles.tableNote}>{t('devices.neverAgain')}</Note>
          {showWarehouse && <Note className={styles.tableNote}>{t('devices.warehouseNote')}</Note>}
        </Card>
        <Card rise index={2}>
          <CardHead title={t('devices.enrollTitle')} />
          <p className={styles.helpText}>{t('devices.enrollHelp')}</p>
          {shownCode?.code && countdown ? (
            <>
              <p className={styles.code}>
                <bdi data-testid="enrollment-code">{shownCode.code}</bdi>
              </p>
              <Chip tone="warn" icon={<Timer aria-hidden="true" />}>
                {t('devices.codeValid', { time: countdown })}
              </Chip>
            </>
          ) : shownCode?.code ? (
            <Alert tone="warn">{t('devices.codeExpired')}</Alert>
          ) : (
            <Note className={styles.tableNote}>
              {openCode
                ? t('devices.openCode', { time: formatTime(openCode.expiresAt) })
                : t('devices.noCode')}
            </Note>
          )}
          {error && <Alert>{error}</Alert>}
          <div className={styles.savebar}>
            <span />
            <Button
              busy={newCode.isPending}
              isDisabled={newCode.isPending}
              onPress={() => {
                setError(null);
                newCode.mutate(null, { onError: (caught) => setError(errorText(caught)) });
              }}
            >
              <RefreshCw className={iconClass.sm} aria-hidden="true" />
              {t('devices.newCode')}
            </Button>
          </div>
        </Card>
      </div>
      <ReceiptPrinterCard index={3} />
      {revoking && <RevokeDialog device={revoking} onClose={() => setRevoking(null)} />}
      {moving && (
        <MoveDrawerDialog device={moving} devices={list} onClose={() => setMoving(null)} />
      )}
      {editing && <EditDeviceDialog device={editing} onClose={() => setEditing(null)} />}
      {untrusting && <EndTrustDialog device={untrusting} onClose={() => setUntrusting(null)} />}
    </>
  );
}

/**
 * The warehouse this PC's documents use by default (M3-T12). Empty = the company's default
 * warehouse, so moving the default in Lists moves these PCs too.
 */
function WarehouseSelect(props: {
  device: DeviceListItem;
  warehouses: WarehouseItem[];
  onError: (text: string | null) => void;
}) {
  const { t, i18n } = useTranslation('settings');
  const toast = useToast();
  const errorText = useErrorText();
  const nameOf = localName(i18n.language);
  const { device } = props;
  const save = useSave(
    (api, body: { defaultWarehouseId: string | null }, key) =>
      api.patch(`/api/v1/devices/${device.id}`, body, { idempotencyKey: key }),
    {
      invalidate: [KEYS.devices],
      onSuccess: () => toast(t('devices.warehouseSaved', { code: device.code })),
    },
  );
  const current = device.defaultWarehouseId ?? '';
  // Shows the choice at once; the list is read again after the save, or goes back on an error.
  const [value, setValue] = useState(current);
  const choices = props.warehouses.filter((w) => w.isActive || w.id === current);
  return (
    <select
      className={deviceStyles.warehouseSelect}
      aria-label={t('devices.warehouseFor', { code: device.code })}
      value={value}
      disabled={save.isPending}
      onChange={(event) => {
        const chosen = event.target.value;
        props.onError(null);
        setValue(chosen);
        save.mutate(
          { defaultWarehouseId: chosen || null },
          {
            onError: (caught) => {
              setValue(current);
              props.onError(errorText(caught));
            },
          },
        );
      }}
    >
      <option value="">{t('devices.defaultWarehouse')}</option>
      {choices.map((w) => (
        <option key={w.id} value={w.id}>
          {`${w.code} · ${nameOf(w)}`}
        </option>
      ))}
    </select>
  );
}

/** Everyone who trusted this PC needs the phone code here again (decision 0027). */
function EndTrustDialog({ device, onClose }: { device: DeviceListItem; onClose: () => void }) {
  const { t, i18n } = useTranslation('settings');
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const end = useSave(
    (api, _: null, key) =>
      api.post(`/api/v1/devices/${device.id}/end-trust`, {}, { idempotencyKey: key }),
    {
      invalidate: [KEYS.devices],
      onSuccess: () => {
        toast(t('devices.trustEnded'));
        onClose();
      },
    },
  );
  const names = new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(
    device.trustedFor.map((person) => nameOf(person)),
  );
  return (
    <Dialog isOpen onClose={onClose} title={t('devices.endTrustTitle')}>
      {error && <Alert>{error}</Alert>}
      <p>{t('devices.endTrustBody', { device: device.code, names })}</p>
      <DialogFooter>
        <Button onPress={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="danger"
          busy={end.isPending}
          isDisabled={end.isPending}
          onPress={() => {
            setError(null);
            end.mutate(null, { onError: (caught) => setError(errorText(caught)) });
          }}
        >
          {t('devices.endTrust')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Revoking is final and needs a reason (decision 0026). */
function RevokeDialog({ device, onClose }: { device: DeviceListItem; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const errorText = useErrorText();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const revoke = useSave(
    (api, body: { reason: string }, key) =>
      api.post(`/api/v1/devices/${device.id}/revoke`, body, { idempotencyKey: key }),
    {
      invalidate: [KEYS.devices],
      onSuccess: () => {
        toast(t('devices.revoked_toast', { code: device.code }));
        onClose();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim().length < 3) return setError(t('common.reasonShort'));
    setError(null);
    revoke.mutate({ reason: reason.trim() }, { onError: (c) => setError(errorText(c)) });
  };
  return (
    <ReasonDialog
      title={t('devices.revokeTitle')}
      who={`${device.code} · ${device.name}`}
      note={t('devices.revokeNote')}
      confirm={t('devices.revokeConfirm')}
      reason={reason}
      onReason={setReason}
      error={error}
      busy={revoke.isPending}
      onSubmit={submit}
      onClose={onClose}
    />
  );
}

/**
 * Decision 0069: a PC enrolled again keeps its drawer. The revoked enrollment's drawer (with its
 * open shift, if any) moves to the active POS PC enrolled in its place; the PC with the same
 * name is offered first.
 */
function MoveDrawerDialog(props: {
  device: DeviceListItem;
  devices: DeviceListItem[];
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const errorText = useErrorText();
  const toast = useToast();
  const { device } = props;
  const targets = props.devices
    .filter((d) => d.status === 'active' && d.kind === 'pos')
    .sort((a, b) => Number(b.code === device.code) - Number(a.code === device.code));
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const move = useSave(
    (api, body: { targetDeviceId: string; reason: string }, key) =>
      api.post(`/api/v1/devices/${device.id}/move-drawer`, body, { idempotencyKey: key }),
    {
      invalidate: [KEYS.devices],
      onSuccess: () => {
        toast(t('devices.drawerMoved', { drawer: device.drawer?.code ?? '' }));
        props.onClose();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!target) return setError(t('devices.noPosTarget'));
    if (reason.trim().length < 3) return setError(t('common.reasonShort'));
    setError(null);
    move.mutate(
      { targetDeviceId: target, reason: reason.trim() },
      { onError: (c) => setError(errorText(c)) },
    );
  };
  return (
    <Dialog isOpen onClose={props.onClose} title={t('devices.moveDrawerTitle')}>
      <form className={styles.ucard} onSubmit={submit} noValidate>
        <Note>
          {t('devices.moveDrawerNote', { drawer: device.drawer?.code ?? '', code: device.code })}
        </Note>
        <SelectField
          id="move-drawer-target"
          label={t('devices.moveDrawerTo')}
          value={target}
          onChange={setTarget}
          options={targets.map((d) => ({ value: d.id, label: `${d.code} · ${d.name}` }))}
        />
        <TextField label={t('common.reason')} value={reason} onChange={setReason} />
        {error && <Alert>{error}</Alert>}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" busy={move.isPending}>
            {t('devices.moveDrawer')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** The owner can rename a PC and change its type later (decision 0024). */
function EditDeviceDialog({ device, onClose }: { device: DeviceListItem; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const errorText = useErrorText();
  const toast = useToast();
  const [name, setName] = useState(device.name);
  const [kind, setKind] = useState<DeviceKind>(device.kind);
  const [error, setError] = useState<string | null>(null);
  const save = useSave(
    (api, body: { name: string; kind: DeviceKind }, key) =>
      api.patch(`/api/v1/devices/${device.id}`, body, { idempotencyKey: key }),
    {
      invalidate: [KEYS.devices],
      onSuccess: () => {
        toast(t('devices.saved'));
        onClose();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setError(null);
    save.mutate({ name: name.trim(), kind }, { onError: (c) => setError(errorText(c)) });
  };
  const kinds: DeviceKind[] =
    device.kind === 'server' ? ['server'] : ['pos', 'office', 'warehouse'];
  return (
    <Dialog isOpen onClose={onClose} title={`${t('devices.editTitle')} · ${device.code}`}>
      <form className={styles.ucard} onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <TextField
          label={t('devices.name')}
          value={name}
          onChange={setName}
          autoFocus
          maxLength={100}
        />
        <div className={styles.ucard}>
          <span className={styles.helpText}>{t('devices.kind')}</span>
          <Segmented
            label={t('devices.kind')}
            block
            value={kind}
            onChange={setKind}
            options={kinds.map((value) => ({ value, label: t(`devices.kinds.${value}`) }))}
          />
        </div>
        <DialogFooter>
          <Button onPress={onClose}>{t('common.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            busy={save.isPending}
            isDisabled={save.isPending || !name.trim()}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
