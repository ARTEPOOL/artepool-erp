/**
 * Accounting → Chart of accounts (decisions 0018, 0035): the provisional chart as a tree. Header
 * accounts group others and never receive postings; a sub-account sits under a header of the
 * same type. An account in use keeps its type, header choice, control flag and active state, and
 * the table says why it is locked. The database enforces every rule again.
 */
import { useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { CheckCircle2, CircleSlash, Link2, Pencil, Plus, Power, PowerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { normalizeCode, CODE_PATTERN } from '@artepool/shared';
import {
  ACCOUNT_TYPES,
  type AccountItem,
  type AccountsResponse,
  type AccountType,
} from '@artepool/shared/contracts';
import {
  Button,
  Card,
  Chip,
  cx,
  Dialog,
  DialogFooter,
  iconClass,
  InfoBar,
  SearchField,
  SelectField,
  Switch,
  tableClasses,
  TextField,
  useToast,
} from '../../ui';
import { useCan } from '../auth/context';
import { DeactivateDialog } from '../masterdata/DeactivateDialog';
import { localName, MD_KEYS } from '../masterdata/refs';
import { useSave } from '../../api/hooks';
import {
  listClasses as styles,
  namesField,
  SaveError,
  useServerFieldError,
} from '../settings/lists/parts';
import { branchOf, indent, treeOrder } from '../settings/lists/tree';

const byCode = (a: AccountItem, b: AccountItem) => a.code.localeCompare(b.code);

/** The editor: an account to change, or a new one (optionally under a chosen header). */
type Editing = { account: AccountItem } | { parent: AccountItem | null };

export function ChartTab({ data }: { data: AccountsResponse }) {
  const { t, i18n } = useTranslation('accounting');
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const nameOf = localName(i18n.language);
  const canManage = can('accounts.manage');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deactivating, setDeactivating] = useState<AccountItem | null>(null);
  const [rowError, setRowError] = useState<unknown>(null);

  const tree = useMemo(() => treeOrder(data.accounts, byCode), [data.accounts]);
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? tree.filter(
        ({ row }) =>
          row.code.toLowerCase().includes(needle) ||
          row.nameAr.toLowerCase().includes(needle) ||
          row.nameEn.toLowerCase().includes(needle),
      )
    : tree;

  const reactivate = useSave(
    (api, account: AccountItem, key) =>
      api.post(
        `/api/v1/accounts/${account.id}/reactivate`,
        { rowVersion: account.rowVersion },
        { idempotencyKey: key },
      ),
    { invalidate: [MD_KEYS.accounts], onSuccess: () => toast(t('masterdata:reactivated')) },
  );
  const deactivate = useSave(
    (api, input: { account: AccountItem; reason: string }, key) =>
      api.post(
        `/api/v1/accounts/${input.account.id}/deactivate`,
        { reason: input.reason, rowVersion: input.account.rowVersion },
        { idempotencyKey: key },
      ),
    {
      invalidate: [MD_KEYS.accounts],
      onSuccess: () => {
        toast(t('masterdata:deactivated'));
        setDeactivating(null);
      },
    },
  );

  return (
    <Card rise index={2} padding="table">
      <div className={styles.tableHead}>
        <div className={styles.headTools}>
          <SearchField
            label={t('chart.search')}
            value={search}
            onChange={setSearch}
            className={styles.search}
          />
          {canManage && (
            <Button variant="primary" onPress={() => setEditing({ parent: null })}>
              <Plus className={iconClass.sm} aria-hidden="true" />
              {t('chart.new')}
            </Button>
          )}
        </div>
        <SaveError
          error={rowError}
          onReload={() => {
            setRowError(null);
            void queryClient.invalidateQueries({ queryKey: MD_KEYS.accounts });
          }}
        />
      </div>
      <table className={tableClasses.table}>
        <thead>
          <tr>
            <th>{t('col.code')}</th>
            <th>{t('col.name')}</th>
            <th>{t('col.type')}</th>
            <th>{t('col.flags')}</th>
            <th>{t('col.inUse')}</th>
            <th>{t('col.status')}</th>
            <th>
              <span className={styles.visuallyHidden}>{t('col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map(({ row, depth }) => {
            const header = !row.isPostable;
            return (
              <tr
                key={row.id}
                data-testid={`account-${row.code}`}
                className={cx(!row.isActive && tableClasses.off)}
              >
                <td className={cx(header && styles.header)}>
                  <bdi>{row.code}</bdi>
                </td>
                <td>
                  <span
                    className={cx(styles.treeName, header && styles.header)}
                    style={{ '--depth': depth } as CSSProperties}
                  >
                    {nameOf(row)}
                  </span>
                </td>
                <td>{t(`types.${row.accountType}`)}</td>
                <td>
                  <span className={styles.chips}>
                    {header && <Chip tone="primary">{t('flags.header')}</Chip>}
                    {row.isControl && <Chip tone="info">{t('flags.control')}</Chip>}
                    {row.isContra && <Chip tone="warn">{t('flags.contra')}</Chip>}
                  </span>
                </td>
                <td>
                  {row.inUse && (
                    <Chip tone="info" icon={<Link2 aria-hidden="true" />}>
                      {t(`inUse.${row.inUse}`)}
                    </Chip>
                  )}
                </td>
                <td>
                  {row.isActive ? (
                    <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
                      {t('masterdata:status.active')}
                    </Chip>
                  ) : (
                    <Chip icon={<CircleSlash aria-hidden="true" />}>
                      {t('masterdata:status.inactive')}
                    </Chip>
                  )}
                </td>
                <td className={tableClasses.num}>
                  {canManage && (
                    <span className={styles.rowTools}>
                      {row.isActive && header && (
                        <Button
                          variant="ghost"
                          aria-label={t('chart.newUnder', { code: row.code })}
                          onPress={() => setEditing({ parent: row })}
                        >
                          <Plus className={iconClass.sm} aria-hidden="true" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        aria-label={t('chart.editOne', { code: row.code })}
                        onPress={() => setEditing({ account: row })}
                      >
                        <Pencil className={iconClass.sm} aria-hidden="true" />
                      </Button>
                      {row.isActive && !row.inUse && (
                        <Button
                          variant="dangerGhost"
                          aria-label={t('chart.deactivateOne', { code: row.code })}
                          onPress={() => {
                            deactivate.reset();
                            setDeactivating(row);
                          }}
                        >
                          <PowerOff className={iconClass.sm} aria-hidden="true" />
                        </Button>
                      )}
                      {!row.isActive && (
                        <Button
                          variant="ghost"
                          busy={reactivate.isPending && reactivate.variables?.id === row.id}
                          onPress={() => {
                            setRowError(null);
                            reactivate.mutate(row, { onError: setRowError });
                          }}
                        >
                          <Power className={iconClass.sm} aria-hidden="true" />
                          {t('masterdata:actions.reactivate')}
                        </Button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
          {shown.length === 0 && (
            <tr className={tableClasses.empty}>
              <td colSpan={7}>{needle ? t('chart.noMatch') : t('chart.empty')}</td>
            </tr>
          )}
        </tbody>
      </table>
      {editing && (
        <AccountDialog
          accounts={data.accounts}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deactivating && (
        <DeactivateDialog
          title={t('chart.deactivateTitle')}
          subject={
            <b>
              <bdi>{deactivating.code}</bdi> · {nameOf(deactivating)}
            </b>
          }
          explanation={t('chart.deactivateNote')}
          busy={deactivate.isPending}
          error={deactivate.error}
          onConfirm={(reason) => deactivate.mutate({ account: deactivating, reason })}
          onClose={() => setDeactivating(null)}
        />
      )}
    </Card>
  );
}

interface AccountForm {
  code: string;
  nameAr: string;
  nameEn: string;
  accountType: AccountType;
  parentId: string;
  isHeader: boolean;
  isControl: boolean;
  isContra: boolean;
}

function toForm(editing: Editing): AccountForm {
  if ('account' in editing) {
    const a = editing.account;
    return {
      code: a.code,
      nameAr: a.nameAr,
      nameEn: a.nameEn,
      accountType: a.accountType,
      parentId: a.parentId ?? '',
      isHeader: !a.isPostable,
      isControl: a.isControl,
      isContra: a.isContra,
    };
  }
  return {
    code: '',
    nameAr: '',
    nameEn: '',
    accountType: editing.parent?.accountType ?? 'asset',
    parentId: editing.parent?.id ?? '',
    isHeader: false,
    isControl: false,
    isContra: false,
  };
}

function AccountDialog(props: { accounts: AccountItem[]; editing: Editing; onClose: () => void }) {
  const { t, i18n } = useTranslation('accounting');
  const toast = useToast();
  const queryClient = useQueryClient();
  const nameOf = localName(i18n.language);
  const [account, setAccount] = useState<AccountItem | null>(
    'account' in props.editing ? props.editing.account : null,
  );
  const [form, setForm] = useState<AccountForm>(() => toForm(props.editing));
  const [local, setLocal] = useState<Record<string, string>>({});
  const set = (patch: Partial<AccountForm>) => setForm((old) => ({ ...old, ...patch }));
  const locked = account?.inUse ?? null;

  const save = useSave(
    (api, body: Record<string, unknown>, key) =>
      account
        ? api.patch(`/api/v1/accounts/${account.id}`, body, { idempotencyKey: key })
        : api.post('/api/v1/accounts', body, { idempotencyKey: key }),
    {
      invalidate: [MD_KEYS.accounts],
      onSuccess: () => {
        toast(t('masterdata:saved'));
        props.onClose();
      },
    },
  );
  const serverError = useServerFieldError(save.error);
  const error = (field: string) => local[field] ?? serverError(field);

  const blocked = account ? branchOf(props.accounts, account.id) : new Set<string>();
  const parentChoices = treeOrder(props.accounts, byCode)
    .filter(
      ({ row }) =>
        row.id === form.parentId ||
        (!row.isPostable &&
          row.isActive &&
          row.accountType === form.accountType &&
          !blocked.has(row.id)),
    )
    .map(({ row, depth }) => ({
      value: row.id,
      label: indent(depth, `${row.code} · ${nameOf(row)}`),
    }));

  const changeType = (accountType: AccountType) => {
    const parent = props.accounts.find((a) => a.id === form.parentId);
    set({
      accountType,
      parentId: parent && parent.accountType === accountType ? form.parentId : '',
    });
  };

  const reload = async () => {
    await queryClient.refetchQueries({ queryKey: MD_KEYS.accounts });
    const fresh = queryClient
      .getQueryData<AccountsResponse>(MD_KEYS.accounts)
      ?.accounts.find((a) => a.id === account?.id);
    save.reset();
    if (fresh) {
      setAccount(fresh);
      setForm(toForm({ account: fresh }));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = normalizeCode(form.code);
    const problems: Record<string, string> = {};
    if (!CODE_PATTERN.test(code)) problems.code = t('lists:codeRule');
    if (!form.nameAr.trim()) problems.nameAr = t('masterdata:fields.required');
    if (!form.nameEn.trim()) problems.nameEn = t('masterdata:fields.required');
    setLocal(problems);
    if (Object.keys(problems).length > 0) return;
    save.mutate({
      code,
      nameAr: form.nameAr.trim(),
      nameEn: form.nameEn.trim(),
      accountType: form.accountType,
      parentId: form.parentId || null,
      isPostable: !form.isHeader,
      isControl: !form.isHeader && form.isControl,
      isContra: form.isContra,
      ...(account ? { rowVersion: account.rowVersion } : {}),
    });
  };

  const fields = ['code', 'nameAr', 'nameEn', 'accountType', 'parentId'];
  return (
    <Dialog
      isOpen
      wide
      onClose={props.onClose}
      title={account ? t('chart.editTitle', { code: account.code }) : t('chart.new')}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        {locked && <InfoBar>{t('chart.lockedWhy', { reason: t(`inUse.${locked}`) })}</InfoBar>}
        {save.error !== null && !namesField(save.error, fields) && (
          <SaveError error={save.error} onReload={() => void reload()} />
        )}
        <div className={styles.grid3}>
          <TextField
            label={t('field.code')}
            value={form.code}
            onChange={(code) => set({ code })}
            ltr
            maxLength={32}
            isRequired
            autoFocus
            error={error('code')}
          />
          <TextField
            label={t('field.nameAr')}
            value={form.nameAr}
            onChange={(nameAr) => set({ nameAr })}
            isRequired
            maxLength={200}
            error={error('nameAr')}
          />
          <TextField
            label={t('field.nameEn')}
            value={form.nameEn}
            onChange={(nameEn) => set({ nameEn })}
            isRequired
            ltr
            maxLength={200}
            error={error('nameEn')}
          />
        </div>
        <div className={styles.grid2}>
          <SelectField
            id="account-type"
            label={t('field.type')}
            value={form.accountType}
            isDisabled={locked !== null}
            onChange={(value) => changeType(value as AccountType)}
            options={ACCOUNT_TYPES.map((value) => ({ value, label: t(`types.${value}`) }))}
          />
          <SelectField
            id="account-parent"
            label={t('field.parent')}
            value={form.parentId}
            onChange={(parentId) => set({ parentId })}
            options={[{ value: '', label: t('field.topLevel') }, ...parentChoices]}
          />
        </div>
        <div className={styles.switches}>
          <Switch
            isSelected={form.isHeader}
            isDisabled={locked !== null}
            onChange={(isHeader) => set({ isHeader, isControl: isHeader ? false : form.isControl })}
          >
            <span className={styles.treeName}>
              <span>{t('field.isHeader')}</span>
              <span className={styles.muted}>{t('field.isHeaderHint')}</span>
            </span>
          </Switch>
          <Switch
            isSelected={!form.isHeader && form.isControl}
            isDisabled={locked !== null || form.isHeader}
            onChange={(isControl) => set({ isControl })}
          >
            <span className={styles.treeName}>
              <span>{t('field.isControl')}</span>
              <span className={styles.muted}>{t('field.isControlHint')}</span>
            </span>
          </Switch>
          <Switch isSelected={form.isContra} onChange={(isContra) => set({ isContra })}>
            <span className={styles.treeName}>
              <span>{t('field.isContra')}</span>
              <span className={styles.muted}>{t('field.isContraHint')}</span>
            </span>
          </Switch>
        </div>
        <DialogFooter>
          <Button onPress={props.onClose}>{t('masterdata:actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {t('masterdata:actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
