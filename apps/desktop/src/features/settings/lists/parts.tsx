/**
 * Small pieces shared by the Lists tabs and the Accounting page: the "someone else changed it"
 * message with its Reload button, server field errors, exact percentages, account choices.
 */
import { useCallback } from 'react';
import { CheckCircle2, CircleSlash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { asciiDigits } from '@artepool/shared';
import type { AccountItem, AccountType } from '@artepool/shared/contracts';
import { ApiError } from '../../../api/client';
import { Alert, Button, Chip, Segmented, type SelectOption } from '../../../ui';
import { errorField, useErrorText } from '../../auth/context';
import { localName } from '../../masterdata/refs';
import styles from './lists.module.css';

export const listClasses = styles;

export const isStale = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'STALE_VERSION';

/**
 * A refused save: "someone else changed this" with a Reload button, or the translated error
 * (business rules included).
 */
export function SaveError({ error, onReload }: { error: unknown; onReload?: () => void }) {
  const { t } = useTranslation('masterdata');
  const errorText = useErrorText();
  if (error === null || error === undefined) return null;
  if (isStale(error)) {
    return (
      <Alert tone="warn">
        <span className={styles.staleText}>{t('stale')}</span>
        {onReload && (
          <Button variant="ghost" onPress={onReload}>
            {t('actions.reload')}
          </Button>
        )}
      </Alert>
    );
  }
  return <Alert>{errorText(error)}</Alert>;
}

/** A message under a select field (text fields show theirs themselves). */
export function FieldMessage({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <span className={styles.fieldError} role="alert">
      {text}
    </span>
  );
}

/** The message under a field the server refused (`masterdata:fields.<code>`). */
export function useServerFieldError(error: unknown): (field: string) => string | undefined {
  const { t, i18n } = useTranslation('masterdata');
  const found = errorField(error);
  return useCallback(
    (field: string) => {
      if (!found || found.field !== field) return undefined;
      const key = `masterdata:fields.${found.code}`;
      return i18n.exists(key) ? t(key) : t('fields.invalid');
    },
    [found, t, i18n],
  );
}

/** Whether a refused save names one of these fields (then no separate message is needed). */
export function namesField(error: unknown, fields: readonly string[]): boolean {
  const found = errorField(error);
  return found !== null && fields.includes(found.field);
}

/**
 * A typed percentage → basis points, exactly (no floats): "5" → 500, "5.25" → 525. At most two
 * decimals and at most 100%; null when the text is not such a number.
 */
export function parsePercent(text: string): number | null {
  const plain = asciiDigits(text.trim()).replace('٫', '.').replace(/%$/, '').trim();
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(plain);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const bp = whole * 100 + fraction;
  return bp > 10_000 ? null : bp;
}

/** Basis points → the text typed in a percentage field (500 → "5", 525 → "5.25"). */
export function percentText(rateBp: number): string {
  const whole = Math.trunc(rateBp / 100);
  const rest = rateBp % 100;
  return rest ? `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}` : String(whole);
}

/** A whole number from 0 to `max` typed in a field, or null. */
export function parseWhole(text: string, max: number): number | null {
  const plain = asciiDigits(text.trim());
  if (!/^\d{1,6}$/.test(plain)) return null;
  const value = Number(plain);
  return value <= max ? value : null;
}

/** "Active" / "Deactivated" with an icon (status is never colour alone). */
export function StatusChip({ active }: { active: boolean }) {
  const { t } = useTranslation('masterdata');
  return active ? (
    <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
      {t('status.active')}
    </Chip>
  ) : (
    <Chip icon={<CircleSlash aria-hidden="true" />}>{t('status.inactive')}</Chip>
  );
}

export type ActiveFilterValue = 'active' | 'inactive' | 'all';

export function ActiveFilter(props: {
  value: ActiveFilterValue;
  onChange: (value: ActiveFilterValue) => void;
}) {
  const { t } = useTranslation('masterdata');
  return (
    <Segmented
      label={t('filters.all')}
      value={props.value}
      onChange={props.onChange}
      options={(['active', 'inactive', 'all'] as const).map((value) => ({
        value,
        label: t(`filters.${value}`),
      }))}
    />
  );
}

export const passesFilter = (filter: ActiveFilterValue, isActive: boolean): boolean =>
  filter === 'all' || (filter === 'active') === isActive;

/** "1110 · Cash on hand" in the screen's language. */
export function useAccountLabel(): (account: AccountItem) => string {
  const { i18n } = useTranslation();
  return useCallback(
    (account: AccountItem) => `${account.code} · ${localName(i18n.language)(account)}`,
    [i18n.language],
  );
}

/** An account that can receive postings directly: active, postable and not a control account. */
export const isPlainAccount = (account: AccountItem, types: readonly AccountType[]): boolean =>
  account.isActive &&
  account.isPostable &&
  !account.isControl &&
  types.includes(account.accountType);

/**
 * Choices for an account field: the suitable accounts, plus the current one even when it is no
 * longer suitable (so the field still shows what is saved), plus "Choose…" when none is chosen.
 */
export function useAccountOptions(): (
  accounts: readonly AccountItem[],
  suitable: (account: AccountItem) => boolean,
  current: string,
) => SelectOption[] {
  const { t } = useTranslation('lists');
  const label = useAccountLabel();
  return useCallback(
    (accounts, suitable, current) => {
      const options = accounts
        .filter((a) => suitable(a) || a.id === current)
        .map((a) => ({ value: a.id, label: label(a) }));
      return current ? options : [{ value: '', label: t('choose') }, ...options];
    },
    [label, t],
  );
}
