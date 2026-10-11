/**
 * Pieces shared by the Customers and Suppliers screens (design 14): the VAT box with its TRN,
 * the "changed by someone else" notice, phone display, payment terms and field errors.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { FileCheck, Receipt, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatPhone } from '@artepool/shared';
import { EMIRATES } from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { Alert, Button, Chip, cx, iconClass, Switch, TextField, type SelectOption } from '../../ui';
import { errorField } from '../auth/context';
import styles from './parties.module.css';

export const partiesClasses = styles;

/** Rows per page of the long lists ("Show more" asks for the next page). */
export const PAGE_SIZE = 50;

/** The same value, `ms` after it stopped changing (search as you type, one call per pause). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Someone else saved the record first: the screen offers to reload it (row versions). */
export const isStale = (error: unknown): boolean =>
  error instanceof ApiError && error.code === 'STALE_VERSION';

export function StaleNotice(props: { onReload: () => void; busy?: boolean }) {
  const { t } = useTranslation('masterdata');
  return (
    <Alert tone="warn">
      <div className={styles.stale}>
        <span>{t('stale')}</span>
        <Button onPress={props.onReload} busy={props.busy}>
          <RotateCw className={iconClass.sm} aria-hidden="true" />
          {t('actions.reload')}
        </Button>
      </div>
    </Alert>
  );
}

/** A stored phone (`+971…`) as people read it (`050 123 4567`), left to right. */
export function Phone({ value }: { value: string | null }) {
  const { t } = useTranslation('masterdata');
  return value ? <bdi>{formatPhone(value)}</bdi> : <>{t('none')}</>;
}

/** The seven emirates, with "none" first. */
export function useEmirateOptions(): SelectOption[] {
  const { t } = useTranslation(['parties', 'masterdata']);
  return [
    { value: '', label: t('parties:form.noEmirate') },
    ...EMIRATES.map((e) => ({ value: e, label: t(`masterdata:emirates.${e}`) })),
  ];
}

/**
 * Payment terms: 0 days is "On receipt". The Arabic counted noun changes with the number
 * (يوم واحد، يومان، 3–10 أيام، 11+ يومًا), so the form is chosen here rather than by i18next plurals.
 */
export function useTermsText(): (days: number) => string {
  const { t } = useTranslation('parties');
  return (days) => {
    if (days === 0) return t('terms.onReceipt');
    if (days === 1) return t('terms.one');
    if (days === 2) return t('terms.two');
    const lastTwo = days % 100;
    return lastTwo >= 3 && lastTwo <= 10 ? t('terms.few', { days }) : t('terms.many', { days });
  };
}

/** Which tax invoice a customer gets follows their VAT registration (decision 0010). */
export function VatChip({ trn }: { trn: string | null }) {
  const { t } = useTranslation('parties');
  return trn ? (
    <>
      <Chip tone="info" icon={<FileCheck aria-hidden="true" />}>
        {t('vat.full')}
      </Chip>
      <span className={styles.sub}>
        <bdi>{t('vat.trn', { trn })}</bdi>
      </span>
    </>
  ) : (
    <>
      <Chip icon={<Receipt aria-hidden="true" />}>{t('vat.simplified')}</Chip>
      <span className={styles.sub}>{t('vat.notRegistered')}</span>
    </>
  );
}

/**
 * Field messages of a form: the ones found on this PC before sending, and the field the server
 * named when it refused the save (a duplicate phone or TRN, a bad e-mail…).
 */
export type FieldErrors = Partial<Record<string, string>>;

export function useServerFieldError(): (error: unknown, fields: readonly string[]) => FieldErrors {
  const { t } = useTranslation('masterdata');
  return (error, fields) => {
    const found = errorField(error);
    if (!found || !fields.includes(found.field)) return {};
    return {
      [found.field]: t(`fields.${found.code}`, { defaultValue: t('fields.invalid') }),
    };
  };
}

/** True when the refused save is already explained under one of the form's fields. */
export function isFieldError(error: unknown, fields: readonly string[]): boolean {
  const found = errorField(error);
  return found !== null && fields.includes(found.field);
}

/**
 * The design's `.vatbox`: the "VAT-registered" switch, which invoice the party gets, and the TRN
 * (15 digits starting with 100) when registered.
 */
export function VatBox(props: {
  isVatRegistered: boolean;
  onVatChange: (value: boolean) => void;
  trn: string;
  onTrnChange: (value: string) => void;
  trnError?: string;
  /** Customers: which tax invoice they get. Suppliers: nothing more. */
  onNote?: ReactNode;
  offNote?: ReactNode;
}) {
  const { t } = useTranslation('parties');
  return (
    <div className={cx(styles.vatbox, props.isVatRegistered && styles.vatOn)}>
      <Switch isSelected={props.isVatRegistered} onChange={props.onVatChange}>
        <span className={styles.vatLabel}>
          <b>{t('form.vat')}</b>
          {(props.isVatRegistered ? props.onNote : props.offNote) && (
            <span className={styles.sub}>
              {props.isVatRegistered ? props.onNote : props.offNote}
            </span>
          )}
        </span>
      </Switch>
      {props.isVatRegistered && (
        <TextField
          label={t('form.trn')}
          value={props.trn}
          onChange={props.onTrnChange}
          ltr
          inputMode="numeric"
          maxLength={20}
          isRequired
          autoComplete="off"
          hint={t('form.trnHint')}
          error={props.trnError}
        />
      )}
    </div>
  );
}

/** Optional text as the API takes it: empty means none. */
export const optional = (value: string): string | null =>
  value.trim() === '' ? null : value.trim();

/** A simple e-mail shape check (the server checks the same). */
export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
