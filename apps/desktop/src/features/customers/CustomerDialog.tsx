import { useState, type FormEvent } from 'react';
import { Building, HardHat, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { normalizePhone, normalizeTrn } from '@artepool/shared';
import type {
  CreateCustomerRequest,
  CustomerDetail,
  CustomerType,
  Emirate,
  UpdateCustomerRequest,
} from '@artepool/shared/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  Note,
  Segmented,
  SelectField,
  TextField,
  useToast,
} from '../../ui';
import { useSave } from '../../api/hooks';
import { useErrorText } from '../auth/context';
import { MD_KEYS } from '../masterdata/refs';
import { customerPath } from './api';
import {
  EMAIL,
  isFieldError,
  isStale,
  optional,
  partiesClasses as styles,
  StaleNotice,
  useEmirateOptions,
  useServerFieldError,
  VatBox,
  type FieldErrors,
} from './parts';

export const CUSTOMER_TYPE_ICONS = {
  individual: <UserRound aria-hidden="true" />,
  contractor: <HardHat aria-hidden="true" />,
  company: <Building aria-hidden="true" />,
} as const;

interface Form {
  customerType: CustomerType | '';
  name: string;
  nameAlt: string;
  phone: string;
  phoneAlt: string;
  email: string;
  addressLine: string;
  area: string;
  city: string;
  emirate: Emirate | '';
  isVatRegistered: boolean;
  trn: string;
  preferredLanguage: 'ar' | 'en' | '';
  notes: string;
}

const EMPTY: Form = {
  customerType: '',
  name: '',
  nameAlt: '',
  phone: '',
  phoneAlt: '',
  email: '',
  addressLine: '',
  area: '',
  city: '',
  emirate: '',
  isVatRegistered: false,
  trn: '',
  preferredLanguage: '',
  notes: '',
};

function formOf(c: CustomerDetail | null): Form {
  if (!c) return EMPTY;
  return {
    customerType: c.customerType,
    name: c.name,
    nameAlt: c.nameAlt ?? '',
    phone: c.phone ?? '',
    phoneAlt: c.phoneAlt ?? '',
    email: c.email ?? '',
    addressLine: c.addressLine ?? '',
    area: c.area ?? '',
    city: c.city ?? '',
    emirate: c.emirate ?? '',
    isVatRegistered: c.isVatRegistered,
    trn: c.trn ?? '',
    preferredLanguage: c.preferredLanguage ?? '',
    notes: c.notes ?? '',
  };
}

const FIELDS = ['customerType', 'name', 'phone', 'phoneAlt', 'email', 'trn'] as const;

/**
 * Design 14 "New customer" / edit: type (decision 0032), names, phones, address, the VAT switch
 * revealing the TRN, preferred language and notes. Credit is changed in its own dialog, by people
 * with `customers.credit`; a new customer always starts as cash (decision 0036).
 */
export function CustomerDialog(props: {
  /** null: a new customer. */
  customer: CustomerDetail | null;
  onReload?: () => Promise<CustomerDetail | null>;
  onClose: () => void;
  onSaved: (customer: CustomerDetail) => void;
}) {
  const { t } = useTranslation(['parties', 'masterdata']);
  const errorText = useErrorText();
  const serverFieldError = useServerFieldError();
  const toast = useToast();
  const emirates = useEmirateOptions();
  const [base, setBase] = useState(props.customer);
  const [form, setForm] = useState<Form>(() => formOf(props.customer));
  const [local, setLocal] = useState<FieldErrors>({});
  const [reloading, setReloading] = useState(false);
  const editing = base !== null;

  const save = useSave(
    (api, body: CreateCustomerRequest | UpdateCustomerRequest, key) =>
      base
        ? api.put<CustomerDetail>(customerPath(base.id), body, { idempotencyKey: key })
        : api.post<CustomerDetail>('/api/v1/customers', body, { idempotencyKey: key }),
    {
      invalidate: [MD_KEYS.customers],
      onSuccess: (saved) => {
        toast(t('masterdata:saved'));
        props.onSaved(saved);
      },
    },
  );
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const errors: FieldErrors = { ...serverFieldError(save.error, FIELDS), ...local };

  const check = (): FieldErrors => {
    const found: FieldErrors = {};
    const required = t('masterdata:fields.required');
    if (!form.customerType) found.customerType = t('parties:form.typeRequired');
    if (!form.name.trim()) found.name = required;
    if (!form.phone.trim()) found.phone = required;
    else if (!normalizePhone(form.phone)) found.phone = t('masterdata:fields.invalid_phone');
    if (form.phoneAlt.trim() && !normalizePhone(form.phoneAlt)) {
      found.phoneAlt = t('masterdata:fields.invalid_phone');
    }
    if (form.email.trim() && !EMAIL.test(form.email.trim())) {
      found.email = t('masterdata:fields.invalid_email');
    }
    if (form.isVatRegistered && !normalizeTrn(form.trn)) {
      found.trn = t('masterdata:fields.invalid_trn');
    }
    return found;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = check();
    setLocal(found);
    if (Object.keys(found).length > 0 || !form.customerType) return;
    const body: CreateCustomerRequest = {
      customerType: form.customerType,
      name: form.name.trim(),
      nameAlt: optional(form.nameAlt),
      phone: form.phone.trim(),
      phoneAlt: optional(form.phoneAlt),
      email: optional(form.email),
      addressLine: optional(form.addressLine),
      area: optional(form.area),
      city: optional(form.city),
      // Not on the form; kept as it is (an import may have filled it).
      poBox: base?.poBox ?? null,
      emirate: form.emirate || null,
      isVatRegistered: form.isVatRegistered,
      trn: form.isVatRegistered ? form.trn.trim() : null,
      preferredLanguage: form.preferredLanguage || null,
      notes: optional(form.notes),
    };
    save.mutate(base ? { ...body, rowVersion: base.rowVersion } : body);
  };

  const reload = async () => {
    if (!props.onReload) return;
    setReloading(true);
    try {
      const fresh = await props.onReload();
      if (fresh) {
        setBase(fresh);
        setForm(formOf(fresh));
        setLocal({});
        save.reset();
      }
    } finally {
      setReloading(false);
    }
  };

  const failure = save.error;
  const typeOptions = (['individual', 'contractor', 'company'] as const).map((value) => ({
    value,
    label: t(`parties:types.${value}`),
    icon: CUSTOMER_TYPE_ICONS[value],
  }));

  return (
    <Dialog
      isOpen
      onClose={props.onClose}
      title={editing ? t('parties:form.editTitle') : t('parties:form.newTitle')}
      wide
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        {failure !== null && isStale(failure) && (
          <StaleNotice onReload={() => void reload()} busy={reloading} />
        )}
        {failure !== null && !isStale(failure) && !isFieldError(failure, FIELDS) && (
          <Alert>{errorText(failure)}</Alert>
        )}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('parties:form.type')}</span>
          <Segmented<CustomerType | ''>
            label={t('parties:form.type')}
            value={form.customerType}
            options={typeOptions}
            onChange={(customerType) => set({ customerType })}
            block
          />
          {errors.customerType && (
            <span className={styles.fieldError} role="alert">
              {errors.customerType}
            </span>
          )}
        </div>
        <div className={styles.grid2}>
          <TextField
            label={t('parties:form.name')}
            value={form.name}
            onChange={(name) => set({ name })}
            autoFocus
            isRequired
            autoComplete="off"
            error={errors.name}
          />
          <TextField
            label={t('parties:form.nameAlt')}
            value={form.nameAlt}
            onChange={(nameAlt) => set({ nameAlt })}
            autoComplete="off"
          />
          <TextField
            label={t('parties:form.phone')}
            value={form.phone}
            onChange={(phone) => set({ phone })}
            ltr
            isRequired
            autoComplete="off"
            placeholder={t('parties:form.phoneHint')}
            error={errors.phone}
          />
          <TextField
            label={t('parties:form.phoneAlt')}
            value={form.phoneAlt}
            onChange={(phoneAlt) => set({ phoneAlt })}
            ltr
            autoComplete="off"
            error={errors.phoneAlt}
          />
          <TextField
            label={t('parties:form.email')}
            value={form.email}
            onChange={(email) => set({ email })}
            ltr
            autoComplete="off"
            error={errors.email}
          />
          <TextField
            label={t('parties:form.address')}
            value={form.addressLine}
            onChange={(addressLine) => set({ addressLine })}
            autoComplete="off"
          />
        </div>
        <div className={styles.grid3}>
          <TextField
            label={t('parties:form.area')}
            value={form.area}
            onChange={(area) => set({ area })}
            autoComplete="off"
          />
          <TextField
            label={t('parties:form.city')}
            value={form.city}
            onChange={(city) => set({ city })}
            autoComplete="off"
          />
          <SelectField
            id="customer-emirate"
            label={t('parties:form.emirate')}
            value={form.emirate}
            options={emirates}
            onChange={(emirate) => set({ emirate: emirate as Emirate | '' })}
          />
        </div>
        <VatBox
          isVatRegistered={form.isVatRegistered}
          onVatChange={(isVatRegistered) => set({ isVatRegistered })}
          trn={form.trn}
          onTrnChange={(trn) => set({ trn })}
          trnError={errors.trn}
          onNote={t('parties:form.vatOn')}
          offNote={t('parties:form.vatOff')}
        />
        <div className={styles.grid2}>
          <SelectField
            id="customer-language"
            label={t('parties:form.language')}
            value={form.preferredLanguage}
            options={[
              { value: '', label: t('parties:languages.none') },
              { value: 'ar', label: t('parties:languages.ar') },
              { value: 'en', label: t('parties:languages.en') },
            ]}
            onChange={(value) => set({ preferredLanguage: value as Form['preferredLanguage'] })}
          />
          <TextField
            label={t('parties:form.notes')}
            value={form.notes}
            onChange={(notes) => set({ notes })}
            multiline
          />
        </div>
        <Note>{t('parties:form.uniqueNote')}</Note>
        {!editing && <Note>{t('parties:form.startsCash')}</Note>}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('masterdata:actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {t('parties:form.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
