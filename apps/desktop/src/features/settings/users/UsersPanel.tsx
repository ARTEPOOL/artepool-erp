import { useEffect, useState, type KeyboardEvent } from 'react';
import { Ban, CheckCircle2, KeyRound, Lock, Plus, ShieldCheck, ShieldPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { RolesResponse, UserListItem, UsersResponse } from '@artepool/shared/contracts';
import { dubaiDay, formatDate, formatTime } from '../../../lib/format';
import {
  Avatar,
  Button,
  Card,
  Chip,
  cx,
  iconClass,
  Note,
  tableClasses,
  useToast,
} from '../../../ui';
import { useCan, useDisplayName } from '../../auth/context';
import { KEYS, useApi } from '../api';
import { NoAccess, PanelHeader, settingsClasses as styles } from '../parts';
import { NewRoleDialog, NewUserDialog, TempCodeDialog, type TempCode } from './dialogs';
import { RolePermissions } from './RolePermissions';
import { UserCard } from './UserCard';

/** Sign-in method → chip (design 13). */
export function MethodChip({ method }: { method: UserListItem['signInMethod'] }) {
  const { t } = useTranslation('settings');
  return method === 'password_totp' ? (
    <Chip tone="ok" icon={<ShieldCheck aria-hidden="true" />}>
      {t('users.methods.password_totp')}
    </Chip>
  ) : (
    <Chip icon={<KeyRound aria-hidden="true" />}>{t(`users.methods.${method}`)}</Chip>
  );
}

export function StatusChip({ user }: { user: UserListItem }) {
  const { t } = useTranslation('settings');
  switch (user.status) {
    case 'active':
      return (
        <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
          {t('users.status.active')}
        </Chip>
      );
    case 'locked':
      return (
        <Chip tone="danger" icon={<Lock aria-hidden="true" />}>
          {t('users.status.locked', { minutes: user.lockedMinutes ?? 15 })}
        </Chip>
      );
    case 'pin_blocked':
      return (
        <Chip tone="danger" icon={<Lock aria-hidden="true" />}>
          {t('users.status.pin_blocked')}
        </Chip>
      );
    case 'inactive':
      return <Chip icon={<Ban aria-hidden="true" />}>{t('users.status.inactive')}</Chip>;
  }
}

function LastSignIn({ at }: { at: string | null }) {
  const { t } = useTranslation('settings');
  if (!at) return <span className={tableClasses.sub}>{t('common.never')}</span>;
  const today = dubaiDay();
  const day = dubaiDay(at);
  if (day === today) return <bdi>{formatTime(at)}</bdi>;
  return <bdi>{formatDate(at)}</bdi>;
}

/** Design 13: Settings → Users & permissions. */
export function UsersPanel() {
  const { t } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const nameOf = useDisplayName();
  const toast = useToast();
  const users = useQuery({
    queryKey: KEYS.users,
    queryFn: () => api.get<UsersResponse>('/api/v1/users'),
    enabled: can('users.view'),
  });
  const roles = useQuery({
    queryKey: KEYS.roles,
    queryFn: () => api.get<RolesResponse>('/api/v1/roles'),
    enabled: can('users.view'),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const [dialog, setDialog] = useState<'user' | 'role' | null>(null);
  const [tempCode, setTempCode] = useState<TempCode | null>(null);

  const list = users.data?.users ?? [];
  useEffect(() => {
    if (selectedId === null && list.length > 0) {
      setSelectedId((list.find((u) => !u.isOwner) ?? list[0])!.id);
    }
  }, [list, selectedId]);

  if (!can('users.view')) return <NoAccess />;
  const selected = list.find((u) => u.id === selectedId) ?? null;
  const role = roles.data?.roles.find((r) => r.id === selected?.roles[0]?.id) ?? null;

  const select = (id: string) => {
    if (id === selectedId) return;
    if (permissionsDirty) {
      toast(t('roles.unsavedSwitch'), 'warn');
      return;
    }
    setSelectedId(id);
  };
  const onRowKey = (event: KeyboardEvent, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(id);
    }
  };

  return (
    <>
      <PanelHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        tools={
          <>
            {can('roles.manage') && (
              <Button onPress={() => setDialog('role')}>
                <ShieldPlus className={iconClass.sm} aria-hidden="true" />
                {t('users.newRole')}
              </Button>
            )}
            {can('users.manage') && (
              <Button variant="primary" onPress={() => setDialog('user')}>
                <Plus className={iconClass.sm} aria-hidden="true" />
                {t('users.newUser')}
              </Button>
            )}
          </>
        }
      />
      <div className={styles.two}>
        <Card rise index={1} padding="table">
          <table className={cx(tableClasses.table, tableClasses.selectable)}>
            <thead>
              <tr>
                <th>{t('users.colUser')}</th>
                <th>{t('users.colSignIn')}</th>
                <th>{t('users.colStatus')}</th>
                <th className={tableClasses.num}>{t('users.colLast')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((user) => (
                <tr
                  key={user.id}
                  tabIndex={0}
                  aria-selected={user.id === selectedId}
                  className={cx(
                    user.id === selectedId && tableClasses.sel,
                    user.status === 'inactive' && tableClasses.off,
                  )}
                  onClick={() => select(user.id)}
                  onKeyDown={(event) => onRowKey(event, user.id)}
                >
                  <td>
                    <div className={tableClasses.who}>
                      <Avatar name={nameOf(user)} />
                      <span>
                        <b>{nameOf(user)}</b>
                        <span className={tableClasses.sub}>
                          {user.roles
                            .map((r) =>
                              nameOf({ displayNameAr: r.nameAr, displayNameEn: r.nameEn }),
                            )
                            .join(' · ') || t('users.noRole')}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td>
                    <MethodChip method={user.signInMethod} />
                  </td>
                  <td>
                    <StatusChip user={user} />
                  </td>
                  <td className={tableClasses.num}>
                    <LastSignIn at={user.lastLoginAt} />
                  </td>
                </tr>
              ))}
              {users.isLoading && (
                <tr className={tableClasses.empty}>
                  <td colSpan={4}>{t('common.loading')}</td>
                </tr>
              )}
            </tbody>
          </table>
          <Note className={styles.tableNote}>{t('users.neverDeleted')}</Note>
        </Card>
        <div className={styles.panel}>
          {selected ? (
            <UserCard
              key={selected.id}
              user={selected}
              roles={roles.data?.roles ?? []}
              onTempCode={setTempCode}
            />
          ) : (
            <Card rise index={2}>
              <Note>{t('users.select')}</Note>
            </Card>
          )}
          {role && roles.data && (
            <RolePermissions
              key={role.id}
              role={role}
              permissions={roles.data.permissions}
              onDirtyChange={setPermissionsDirty}
            />
          )}
        </div>
      </div>
      {dialog === 'user' && (
        <NewUserDialog
          roles={roles.data?.roles ?? []}
          onClose={() => setDialog(null)}
          onCreated={(result) => {
            setDialog(null);
            setSelectedId(result.user.id);
            setTempCode(result);
          }}
        />
      )}
      {dialog === 'role' && (
        <NewRoleDialog roles={roles.data?.roles ?? []} onClose={() => setDialog(null)} />
      )}
      {tempCode && <TempCodeDialog code={tempCode} onClose={() => setTempCode(null)} />}
    </>
  );
}
