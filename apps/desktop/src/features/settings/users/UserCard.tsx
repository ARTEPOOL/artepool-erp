import { useState } from 'react';
import { Ban, KeyRound, Lock, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RoleInfo, TemporaryCodeResponse, UserListItem } from '@artepool/shared/contracts';
import {
  Alert,
  Avatar,
  Button,
  Card,
  Chip,
  iconClass,
  Note,
  SelectField,
  tableClasses,
  useToast,
} from '../../../ui';
import { useCan, useDisplayName, useErrorText } from '../../auth/context';
import { KEYS, useSave } from '../api';
import { settingsClasses as styles } from '../parts';
import { StatusChip } from './UsersPanel';
import { DeactivateDialog, type TempCode } from './dialogs';

const userPath = (id: string, action = '') => `/api/v1/users/${id}${action}`;

/** The selected user's card (design 13): role, temporary code, unlock, deactivate. */
export function UserCard(props: {
  user: UserListItem;
  roles: RoleInfo[];
  onTempCode: (code: TempCode) => void;
}) {
  const { t } = useTranslation('settings');
  const can = useCan();
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const toast = useToast();
  const { user } = props;
  const [error, setError] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const inactive = user.status === 'inactive';
  const manage = can('users.manage');
  const invalidate = [KEYS.users, KEYS.roles];
  const onError = (caught: unknown) => setError(errorText(caught));

  const changeRole = useSave(
    (api, roleId: string, key) =>
      api.patch<UserListItem>(userPath(user.id), { roleId }, { idempotencyKey: key }),
    { invalidate, onSuccess: () => toast(t('users.roleChanged')) },
  );
  const reset = useSave(
    (api, _: null, key) =>
      api.post<TemporaryCodeResponse>(
        userPath(user.id, '/reset-credentials'),
        {},
        {
          idempotencyKey: key,
        },
      ),
    { invalidate, onSuccess: (result) => props.onTempCode(result) },
  );
  const unlock = useSave(
    (api, _: null, key) =>
      api.post<UserListItem>(userPath(user.id, '/unlock'), {}, { idempotencyKey: key }),
    {
      invalidate,
      onSuccess: () =>
        toast(user.status === 'pin_blocked' ? t('users.pinUnblocked') : t('users.unlocked')),
    },
  );
  const reactivate = useSave(
    (api, _: null, key) =>
      api.post<UserListItem>(userPath(user.id, '/reactivate'), {}, { idempotencyKey: key }),
    { invalidate, onSuccess: () => toast(t('users.reactivated')) },
  );

  const roleOptions = props.roles
    .filter((r) => r.isActive && (r.code !== 'owner' || user.isOwner))
    .map((r) => ({
      value: r.id,
      label: nameOf({ displayNameAr: r.nameAr, displayNameEn: r.nameEn }),
    }));
  const currentRole = user.roles[0]?.id ?? '';

  return (
    <Card rise index={2}>
      <div className={styles.cardHead}>
        <div className={tableClasses.who}>
          <Avatar name={nameOf(user)} />
          <span>
            <h2 className={styles.userName}>{nameOf(user)}</h2>
            <bdi className={tableClasses.sub}>{user.username}</bdi>
          </span>
        </div>
        <StatusChip user={user} />
      </div>
      <div className={styles.ucard}>
        {inactive && (
          <div className={styles.offbar}>
            <Ban aria-hidden="true" />
            <span>{t('users.deactivatedBy', { reason: user.deactivationReason ?? '' })}</span>
          </div>
        )}
        {user.mustChange && !inactive && <Chip tone="info">{t('users.mustChange')}</Chip>}
        {error && <Alert>{error}</Alert>}
        <SelectField
          id={`role-${user.id}`}
          label={t('users.role')}
          value={currentRole}
          options={
            currentRole ? roleOptions : [{ value: '', label: t('users.noRole') }, ...roleOptions]
          }
          isDisabled={user.isOwner || inactive || !manage || changeRole.isPending}
          onChange={(roleId) => {
            setError(null);
            if (roleId && roleId !== currentRole) changeRole.mutate(roleId, { onError });
          }}
        />
        <div className={styles.uacts}>
          {!user.isOwner && can('users.reset_credentials') && (
            <Button
              isDisabled={inactive || reset.isPending}
              onPress={() => {
                setError(null);
                reset.mutate(null, { onError });
              }}
            >
              <KeyRound className={iconClass.sm} aria-hidden="true" />
              {user.signInMethod === 'pin' ? t('users.newPin') : t('users.resetPassword')}
            </Button>
          )}
          {manage && (user.status === 'locked' || user.status === 'pin_blocked') && (
            <Button isDisabled={unlock.isPending} onPress={() => unlock.mutate(null, { onError })}>
              <Lock className={iconClass.sm} aria-hidden="true" />
              {user.status === 'pin_blocked' ? t('users.unblockPin') : t('users.unlock')}
            </Button>
          )}
          {manage && !user.isOwner && inactive && (
            <Button
              isDisabled={reactivate.isPending}
              onPress={() => reactivate.mutate(null, { onError })}
            >
              <Undo2 className={iconClass.sm} aria-hidden="true" />
              {t('users.reactivate')}
            </Button>
          )}
          {manage && !user.isOwner && !inactive && (
            <Button variant="dangerGhost" onPress={() => setDeactivating(true)}>
              <Ban className={iconClass.sm} aria-hidden="true" />
              {t('users.deactivate')}
            </Button>
          )}
        </div>
        {user.isOwner && <Note>{t('users.ownerNote')}</Note>}
      </div>
      {deactivating && <DeactivateDialog user={user} onClose={() => setDeactivating(false)} />}
    </Card>
  );
}
