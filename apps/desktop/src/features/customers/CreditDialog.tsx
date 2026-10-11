import { useState, type FormEvent } from 'react';
import { Banknote, CreditCard, ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MoneyFormatError, parseFils, asciiDigits } from '@artepool/shared';
import type {
  CreditMode,
  CustomerDetail,
  SetCustomerCreditRequest,
} from '@artepool/shared/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  InfoBar,
  Segmented,
  SelectField,
  TextField,
  useToast,
} from '../../ui';
import { useSave } from '../../api/hooks';
import { useErrorText } from '../auth/context';
import { MD_KEYS } from '../masterdata/refs';
import { money } from '../masterdata/format';
import { customerPath } from './api';
import {
  isStale,
  partiesClasses as styles,
  StaleNotice,
  useTermsText,
  type FieldErrors,
} from './parts';

const TERMS = [0, 15, 30, 45, 60, 90] as const;
const OTHER = 'other';

interface Form {
  mode: CreditMode;
  limit: string;
  /** One of TERMS as text, or OTHER. */
  termsChoice: string;
  termsOther: string;
  reason: string;
}

function formOf(c: CustomerDetail): Form {
  const credit = c.creditMode === 'credit';
  const listed = (TERMS as readonly number[]).includes(c.paymentTermsDays);
  return {
    mode: c.creditMode,
    limit: credit ? money(BigInt(c.creditLimitFils)).replace(/,/g, '') : '',
    termsChoice: !credit || listed ? String(credit ? c.paymentTermsDays : 0) : OTHER,
    termsOther: credit && !listed ? String(c.paymentTermsDays) : '',
    reason: '',
  };
}

/** Whole AED amount as typed ("5,000" or "5000.50") → fils, or null when not a valid amount. */
function filsOf(text: string): bigint | null {
  try {
    return parseFils(text.replace(/,/g, ''));
  } catch (error) {
    if (error instanceof MoneyFormatError) return null;
    throw error;
  }
}

/**
 * Cash or credit (decision 0036): only people with `customers.credit`, always with a written
 * reason that the audit log keeps with the old and new values.
 */
export function CreditDialog(props: {
  customer: CustomerDetail;
  onReload: () => Promise<CustomerDetail | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation(['parties', 'masterdata']);
  const errorText = useErrorText();
  const toast = useToast();
  const termsText = useTermsText();
  const [base, setBase] = useState(props.customer);
  const [form, setForm] = useState<Form>(() => formOf(props.customer));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [reloading, setReloading] = useState(false);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const save = useSave(
    (api, body: SetCustomerCreditRequest, key) =>
      api.post<CustomerDetail>(customerPath(base.id, '/credit'), body, { idempotencyKey: key }),
    {
      invalidate: [MD_KEYS.customers],
      onSuccess: () => {
        toast(t('parties:credit.saved'));
        props.onClose();
      },
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: FieldErrors = {};
    let limitFils = 0n;
    let days = 0;
    if (form.mode === 'credit') {
      const fils = form.limit.trim() ? filsOf(form.limit.trim()) : null;
      if (!form.limit.trim()) found.limit = t('masterdata:fields.required');
      else if (fils === null) found.limit = t('parties:credit.limitInvalid');
      else if (fils <= 0n) found.limit = t('masterdata:fields.too_small');
      else limitFils = fils;
      if (form.termsChoice === OTHER) {
        const text = form.termsOther.trim();
        days = /^\d{1,3}$/.test(asciiDigits(text)) ? Number(asciiDigits(text)) : -1;
        if (days < 0 || days > 365) found.terms = t('parties:credit.termsInvalid');
      } else {
        days = Number(form.termsChoice);
      }
    }
    if (form.reason.trim().length < 3) found.reason = t('masterdata:deactivate.reasonTooShort');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    save.mutate({
      credit:
        form.mode === 'cash'
          ? { mode: 'cash' }
          : { mode: 'credit', creditLimitFils: limitFils.toString(), paymentTermsDays: days },
      reason: form.reason.trim(),
      rowVersion: base.rowVersion,
    });
  };

  const reload = async () => {
    setReloading(true);
    try {
      const fresh = await props.onReload();
      if (fresh) {
        setBase(fresh);
        setForm(formOf(fresh));
        setErrors({});
        save.reset();
      }
    } finally {
      setReloading(false);
    }
  };

  const termsOptions = [
    ...TERMS.map((days) => ({
      value: String(days),
      label: termsText(days),
    })),
    { value: OTHER, label: t('parties:credit.otherTerms') },
  ];

  return (
    <Dialog isOpen onClose={props.onClose} title={t('parties:credit.title')}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div>
          <b>{base.name}</b>
          <span className={styles.sub}>
            {base.creditMode === 'credit'
              ? t('parties:credit.nowCredit', { amount: money(BigInt(base.creditLimitFils)) })
              : t('parties:credit.nowCash')}
          </span>
        </div>
        {save.error !== null && isStale(save.error) && (
          <StaleNotice onReload={() => void reload()} busy={reloading} />
        )}
        {save.error !== null && !isStale(save.error) && <Alert>{errorText(save.error)}</Alert>}
        <Segmented<CreditMode>
          label={t('parties:credit.mode')}
          value={form.mode}
          options={[
            {
              value: 'cash',
              label: t('parties:credit.cash'),
              icon: <Banknote aria-hidden="true" />,
            },
            {
              value: 'credit',
              label: t('parties:credit.credit'),
              icon: <CreditCard aria-hidden="true" />,
            },
          ]}
          onChange={(mode) => set({ mode })}
          block
        />
        {form.mode === 'credit' ? (
          <div className={styles.creditRow}>
            <TextField
              label={t('parties:credit.limit')}
              value={form.limit}
              onChange={(limit) => set({ limit })}
              ltr
              inputMode="numeric"
              placeholder="0.00"
              isRequired
              error={errors.limit}
            />
            <SelectField
              id="credit-terms"
              label={t('parties:credit.terms')}
              value={form.termsChoice}
              options={termsOptions}
              onChange={(termsChoice) => set({ termsChoice })}
            />
            {form.termsChoice === OTHER && (
              <TextField
                label={t('parties:credit.termsDays')}
                value={form.termsOther}
                onChange={(termsOther) => set({ termsOther })}
                ltr
                inputMode="numeric"
                maxLength={3}
                error={errors.terms}
              />
            )}
          </div>
        ) : (
          <InfoBar>{t('parties:credit.cashExplain')}</InfoBar>
        )}
        <TextField
          label={t('masterdata:deactivate.reason')}
          value={form.reason}
          onChange={(reason) => set({ reason })}
          multiline
          isRequired
          placeholder={t('masterdata:deactivate.reasonHint')}
          error={errors.reason}
        />
        <InfoBar icon={<ScrollText aria-hidden="true" />}>{t('parties:credit.audited')}</InfoBar>
        <DialogFooter>
          <Button onPress={props.onClose}>{t('masterdata:actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {t('parties:credit.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
