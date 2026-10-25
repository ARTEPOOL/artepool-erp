import { useState, type FormEvent } from 'react';
import { Landmark, Pencil, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { formatIban, normalizeSwift, normalizeUaeIban } from '@artepool/shared';
import type {
  BankAccount,
  BankAccountsResponse,
  SaveBankAccountRequest,
} from '@artepool/shared/contracts';
import { ApiError } from '../../../api/client';
import { useApi, useSave } from '../../../api/hooks';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogFooter,
  EmptyState,
  iconClass,
  Note,
  TextField,
  useToast,
} from '../../../ui';
import { useErrorText } from '../../auth/context';
import { DeactivateDialog } from '../../masterdata/DeactivateDialog';
import { CardHead, Section } from '../parts';
import styles from './company.module.css';

export const BANK_KEY = ['md', 'bank-accounts'];

export function useBankAccounts() {
  const api = useApi();
  return useQuery({
    queryKey: BANK_KEY,
    queryFn: () => api.get<BankAccountsResponse>('/api/v1/company/bank-accounts'),
  });
}

/**
 * Settings → Company → Bank accounts (decision 0065): several accounts, a UAE IBAN checked here
 * and again by the server and the database. Owner only; an account is deactivated with a reason,
 * never deleted. Which one prints is chosen in the print designer.
 */
export function BankAccountsCard({ index }: { index: number }) {
  const { t } = useTranslation('setup');
  const errorText = useErrorText();
  const query = useBankAccounts();
  const [editing, setEditing] = useState<BankAccount | 'new' | null>(null);
  const [stopping, setStopping] = useState<BankAccount | null>(null);
  const toast = useToast();
  const setActive = useSave(
    (client, input: { account: BankAccount; active: boolean; reason?: string }, key) =>
      client.post(
        `/api/v1/company/bank-accounts/${input.account.id}/${input.active ? 'reactivate' : 'deactivate'}`,
        { rowVersion: input.account.rowVersion, ...(input.reason ? { reason: input.reason } : {}) },
        { idempotencyKey: key },
      ),
    {
      invalidate: [BANK_KEY],
      onSuccess: (_, input) => {
        setStopping(null);
        toast(input.active ? t('company.bank.reactivated') : t('company.bank.deactivated'));
      },
    },
  );
  const canEdit = query.data?.canEdit ?? false;
  const accounts = query.data?.accounts ?? [];
  return (
    <Section index={index}>
      <CardHead title={t('company.bank.title')}>
        {canEdit && (
          <Button onPress={() => setEditing('new')}>
            <Plus className={iconClass.sm} aria-hidden="true" />
            {t('company.bank.add')}
          </Button>
        )}
      </CardHead>
      {query.isError && <Alert>{errorText(query.error)}</Alert>}
      {query.data && accounts.length === 0 && <EmptyState>{t('company.bank.empty')}</EmptyState>}
      {accounts.length > 0 && (
        <ul className={styles.banks} aria-label={t('company.bank.title')}>
          {accounts.map((a) => (
            <li key={a.id} className={styles.bank} data-inactive={!a.isActive || undefined}>
              <Landmark className={iconClass.md} aria-hidden="true" />
              <div className={styles.bankText}>
                <strong>{a.bankName}</strong>
                <span>{a.accountName}</span>
                <bdi className={styles.iban}>{formatIban(a.iban)}</bdi>
                {a.swift && (
                  <span>
                    {t('company.bank.swift')}: <bdi>{a.swift}</bdi>
                  </span>
                )}
              </div>
              {!a.isActive && <Chip tone="neutral">{t('company.bank.inactive')}</Chip>}
              {canEdit && (
                <div className={styles.bankTools}>
                  {a.isActive ? (
                    <>
                      <Button variant="ghost" onPress={() => setEditing(a)}>
                        <Pencil className={iconClass.sm} aria-hidden="true" />
                        {t('company.bank.edit')}
                      </Button>
                      <Button variant="dangerGhost" onPress={() => setStopping(a)}>
                        {t('company.bank.deactivate')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      busy={setActive.isPending}
                      onPress={() => setActive.mutate({ account: a, active: true })}
                    >
                      {t('company.bank.reactivate')}
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Note>{t('company.bank.note')}</Note>
      {setActive.error !== null && !stopping && <Alert>{errorText(setActive.error)}</Alert>}
      {editing && (
        <BankAccountDialog
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {stopping && (
        <DeactivateDialog
          title={t('company.bank.deactivateTitle')}
          subject={
            <>
              <strong>{stopping.bankName}</strong> · <bdi>{formatIban(stopping.iban)}</bdi>
            </>
          }
          explanation={t('company.bank.deactivateHelp')}
          busy={setActive.isPending}
          error={setActive.error}
          onConfirm={(reason) => setActive.mutate({ account: stopping, active: false, reason })}
          onClose={() => setStopping(null)}
        />
      )}
    </Section>
  );
}

type Form = { bankName: string; accountName: string; iban: string; swift: string };

function BankAccountDialog({
  account,
  onClose,
}: {
  account: BankAccount | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('setup');
  const errorText = useErrorText();
  const toast = useToast();
  const [form, setForm] = useState<Form>({
    bankName: account?.bankName ?? '',
    accountName: account?.accountName ?? '',
    iban: account ? formatIban(account.iban) : '',
    swift: account?.swift ?? '',
  });
  const [problems, setProblems] = useState<Partial<Record<keyof Form, string>>>({});
  const save = useSave(
    (client, body: SaveBankAccountRequest, key) =>
      account
        ? client.patch<BankAccount>(`/api/v1/company/bank-accounts/${account.id}`, body, {
            idempotencyKey: key,
          })
        : client.post<BankAccount>('/api/v1/company/bank-accounts', body, { idempotencyKey: key }),
    {
      invalidate: [BANK_KEY],
      onSuccess: () => {
        toast(t('company.bank.saved'));
        onClose();
      },
    },
  );
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Partial<Record<keyof Form, string>> = {};
    if (!form.bankName.trim()) found.bankName = t('company.bank.required');
    if (!form.accountName.trim()) found.accountName = t('company.bank.required');
    if (!normalizeUaeIban(form.iban)) found.iban = t('company.bank.ibanRule');
    if (form.swift.trim() && !normalizeSwift(form.swift)) found.swift = t('company.bank.swiftRule');
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    save.mutate({
      bankName: form.bankName.trim(),
      accountName: form.accountName.trim(),
      iban: form.iban,
      swift: form.swift.trim() || null,
      ...(account ? { rowVersion: account.rowVersion } : {}),
    });
  };

  // The server's own field check (a duplicate IBAN, a wrong checksum) shows under the field.
  const serverField =
    save.error instanceof ApiError
      ? ((save.error.details.field as string | undefined) ??
        (save.error.details.issues as { path?: string[] }[] | undefined)?.[0]?.path?.[0])
      : undefined;
  const fieldError = (name: keyof Form) =>
    problems[name] ??
    (serverField === name
      ? save.error instanceof ApiError && save.error.code === 'DUPLICATE'
        ? t('company.bank.duplicate')
        : t(name === 'iban' ? 'company.bank.ibanRule' : 'company.bank.swiftRule')
      : undefined);

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={account ? t('company.bank.editTitle') : t('company.bank.addTitle')}
    >
      <form onSubmit={submit} noValidate className={styles.form}>
        <TextField
          label={t('company.bank.bankName')}
          value={form.bankName}
          onChange={(bankName) => set({ bankName })}
          maxLength={100}
          isRequired
          autoFocus
          error={fieldError('bankName')}
        />
        <TextField
          label={t('company.bank.accountName')}
          value={form.accountName}
          onChange={(accountName) => set({ accountName })}
          maxLength={150}
          isRequired
          error={fieldError('accountName')}
        />
        <TextField
          label={t('company.bank.iban')}
          value={form.iban}
          onChange={(iban) => set({ iban })}
          ltr
          maxLength={40}
          isRequired
          placeholder={t('company.bank.ibanPlaceholder')}
          hint={t('company.bank.ibanHint')}
          error={fieldError('iban')}
        />
        <TextField
          label={t('company.bank.swiftOptional')}
          value={form.swift}
          onChange={(swift) => set({ swift })}
          ltr
          maxLength={11}
          placeholder={t('company.bank.swiftPlaceholder')}
          error={fieldError('swift')}
        />
        {save.error !== null && !serverField && (
          <div className={styles.wide}>
            <Alert>{errorText(save.error)}</Alert>
          </div>
        )}
        <div className={styles.wide}>
          <DialogFooter>
            <Button onPress={onClose}>{t('company.bank.cancel')}</Button>
            <Button type="submit" variant="primary" busy={save.isPending}>
              {t('company.bank.save')}
            </Button>
          </DialogFooter>
        </div>
      </form>
    </Dialog>
  );
}
