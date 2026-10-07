import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CreateUserRequest,
  RoleInfo,
  TemporaryCodeResponse,
  UserListItem,
} from '@artepool/shared/contracts';
import { ApiError } from '../../../api/client';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  Note,
  SelectField,
  TextField,
  useToast,
} from '../../../ui';
import { useDisplayName, useErrorText } from '../../auth/context';
import { KEYS, useSave } from '../api';
import { settingsClasses as styles } from '../parts';

export type TempCode = Pick<TemporaryCodeResponse, 'user' | 'temporaryCode' | 'kind'>;

const roleName = (nameOf: ReturnType<typeof useDisplayName>, role: RoleInfo) =>
  nameOf({ displayNameAr: role.nameAr, displayNameEn: role.nameEn });

/** Design 13 "New user": names, username, role and sign-in method; a temporary code follows. */
export function NewUserDialog(props: {
  roles: RoleInfo[];
  onClose: () => void;
  onCreated: (result: TemporaryCodeResponse) => void;
}) {
  const { t } = useTranslation('settings');
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const assignable = props.roles.filter((r) => r.isActive && r.code !== 'owner');
  const cashier = assignable.find((r) => r.code === 'cashier') ?? assignable[0];
  const [form, setForm] = useState({
    displayNameAr: '',
    displayNameEn: '',
    username: '',
    roleId: cashier?.id ?? '',
    signInMethod: (cashier?.code === 'cashier'
      ? 'pin'
      : 'password') as CreateUserRequest['signInMethod'],
  });
  const [error, setError] = useState<{ text: string; field?: string } | null>(null);
  const create = useSave(
    (api, body: CreateUserRequest, key) =>
      api.post<TemporaryCodeResponse>('/api/v1/users', body, { idempotencyKey: key }),
    { invalidate: [KEYS.users, KEYS.roles], onSuccess: props.onCreated },
  );
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const username = form.username.trim().toLowerCase();
    if (!form.displayNameAr.trim() || !form.displayNameEn.trim() || !username || !form.roleId) {
      return setError({ text: t('newUser.missing') });
    }
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      return setError({ text: t('newUser.usernameInvalid'), field: 'username' });
    }
    setError(null);
    create.mutate(
      { ...form, username },
      {
        onError: (caught) =>
          setError({
            text: errorText(caught),
            field:
              caught instanceof ApiError && caught.code === 'DUPLICATE' ? 'username' : undefined,
          }),
      },
    );
  };

  return (
    <Dialog isOpen onClose={props.onClose} title={t('newUser.title')} wide>
      <form className={styles.ucard} onSubmit={submit} noValidate>
        {error && !error.field && <Alert>{error.text}</Alert>}
        <div className={styles.grid2}>
          <TextField
            label={t('newUser.nameAr')}
            value={form.displayNameAr}
            onChange={(displayNameAr) => set({ displayNameAr })}
            autoFocus
            isRequired
          />
          <TextField
            label={t('newUser.nameEn')}
            value={form.displayNameEn}
            onChange={(displayNameEn) => set({ displayNameEn })}
            ltr
            isRequired
          />
          <TextField
            label={t('newUser.username')}
            value={form.username}
            onChange={(username) => set({ username })}
            ltr
            isRequired
            autoComplete="off"
            hint={t('newUser.usernameHint')}
            error={error?.field === 'username' ? error.text : undefined}
          />
          <SelectField
            id="new-user-role"
            label={t('newUser.role')}
            value={form.roleId}
            options={assignable.map((r) => ({ value: r.id, label: roleName(nameOf, r) }))}
            onChange={(roleId) => set({ roleId })}
          />
        </div>
        <SelectField
          id="new-user-method"
          label={t('newUser.method')}
          value={form.signInMethod}
          options={(['pin', 'password', 'password_totp'] as const).map((value) => ({
            value,
            label: t(`newUser.methods.${value}`),
          }))}
          onChange={(value) => set({ signInMethod: value as CreateUserRequest['signInMethod'] })}
        />
        <Note>{t('newUser.note')}</Note>
        <DialogFooter>
          <Button onPress={props.onClose}>{t('common.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            busy={create.isPending}
            isDisabled={create.isPending}
          >
            {t('newUser.create')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Design 13 "New role": two names and the role to copy permissions from. */
export function NewRoleDialog(props: { roles: RoleInfo[]; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const toast = useToast();
  const sources = props.roles.filter((r) => r.isActive && r.code !== 'owner');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [copyFromRoleId, setCopyFrom] = useState(
    sources.find((r) => r.code === 'cashier')?.id ?? sources[0]?.id ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const create = useSave(
    (api, body: { nameAr: string; nameEn: string; copyFromRoleId: string }, key) =>
      api.post<RoleInfo>('/api/v1/roles', body, { idempotencyKey: key }),
    {
      invalidate: [KEYS.roles],
      onSuccess: () => {
        toast(t('newRole.created'));
        props.onClose();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!nameAr.trim() || !nameEn.trim()) return setError(t('newRole.missing'));
    setError(null);
    create.mutate(
      { nameAr: nameAr.trim(), nameEn: nameEn.trim(), copyFromRoleId },
      { onError: (caught) => setError(errorText(caught)) },
    );
  };
  return (
    <Dialog isOpen onClose={props.onClose} title={t('newRole.title')}>
      <form className={styles.ucard} onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <div className={styles.grid2}>
          <TextField label={t('newRole.nameAr')} value={nameAr} onChange={setNameAr} autoFocus />
          <TextField label={t('newRole.nameEn')} value={nameEn} onChange={setNameEn} ltr />
        </div>
        <SelectField
          id="new-role-from"
          label={t('newRole.copyFrom')}
          value={copyFromRoleId}
          options={sources.map((r) => ({ value: r.id, label: roleName(nameOf, r) }))}
          onChange={setCopyFrom}
        />
        <DialogFooter>
          <Button onPress={props.onClose}>{t('common.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            busy={create.isPending}
            isDisabled={create.isPending}
          >
            {t('newRole.create')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** The temporary password or PIN, shown once (design 13 "Temporary code"). */
export function TempCodeDialog({ code, onClose }: { code: TempCode; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const nameOf = useDisplayName();
  const name = nameOf(code.user);
  return (
    <Dialog isOpen onClose={onClose} title={t('temp.title')} dismissable={false}>
      <p>{code.kind === 'pin' ? t('temp.pin', { name }) : t('temp.password', { name })}</p>
      {code.temporaryCode ? (
        <div className={styles.tempcode} data-testid="temporary-code">
          {code.temporaryCode}
        </div>
      ) : (
        <Alert tone="warn">{t('temp.repeat')}</Alert>
      )}
      <Note>{t('temp.note')}</Note>
      <DialogFooter>
        <Button variant="primary" onPress={onClose}>
          {t('common.done')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Deactivating always needs a reason (decision 0026); the user can be reactivated later. */
export function DeactivateDialog({ user, onClose }: { user: UserListItem; onClose: () => void }) {
  const { t } = useTranslation('settings');
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const deactivate = useSave(
    (api, body: { reason: string }, key) =>
      api.post<UserListItem>(`/api/v1/users/${user.id}/deactivate`, body, { idempotencyKey: key }),
    {
      invalidate: [KEYS.users, KEYS.roles],
      onSuccess: () => {
        toast(t('users.deactivated'));
        onClose();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim().length < 3) return setError(t('common.reasonShort'));
    setError(null);
    deactivate.mutate({ reason: reason.trim() }, { onError: (c) => setError(errorText(c)) });
  };
  return (
    <ReasonDialog
      title={t('deactivate.title')}
      who={nameOf(user)}
      note={t('deactivate.note')}
      confirm={t('deactivate.confirm')}
      reason={reason}
      onReason={setReason}
      error={error}
      busy={deactivate.isPending}
      onSubmit={submit}
      onClose={onClose}
    />
  );
}

/** A confirmation that needs a written reason (deactivate a user, revoke a PC). */
export function ReasonDialog(props: {
  title: string;
  who: string;
  note: string;
  confirm: string;
  reason: string;
  onReason: (value: string) => void;
  error: string | null;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <Dialog isOpen onClose={props.onClose} title={props.title}>
      <form className={styles.ucard} onSubmit={props.onSubmit} noValidate>
        <p>
          <b>
            <bdi>{props.who}</bdi>
          </b>
        </p>
        <Note>{props.note}</Note>
        {props.error && <Alert>{props.error}</Alert>}
        <TextField
          label={t('common.reason')}
          value={props.reason}
          onChange={props.onReason}
          multiline
          autoFocus
          maxLength={500}
          placeholder={t('common.reasonPlaceholder')}
        />
        <DialogFooter>
          <Button onPress={props.onClose}>{t('common.cancel')}</Button>
          <Button
            type="submit"
            variant="danger"
            busy={props.busy}
            isDisabled={props.busy || props.reason.trim().length < 3}
          >
            {props.confirm}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
