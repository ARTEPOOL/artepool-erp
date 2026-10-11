import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizePhone, normalizeTrn, asciiDigits } from '@artepool/shared';
import type {
  CreateSupplierRequest,
  Emirate,
  SupplierDetail,
  UpdateSupplierRequest,
} from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  Note,
  SelectField,
  TextField,
  useToast,
} from '../../ui';
import { useErrorText } from '../auth/context';
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
} from '../customers/parts';
import { MD_KEYS } from '../masterdata/refs';
import { supplierPath } from './api';

interface Form {
  name: string;
  nameAlt: string;
  phone: string;
  email: string;
  addressLine: string;
  city: string;
  emirate: Emirate | '';
  countryCode: string;
  isVatRegistered: boolean;
  trn: string;
  paymentTermsDays: string;
  notes: string;
}

function formOf(s: SupplierDetail | null): Form {
  return {
    name: s?.name ?? '',
    nameAlt: s?.nameAlt ?? '',
    phone: s?.phone ?? '',
    email: s?.email ?? '',
    addressLine: s?.addressLine ?? '',
    city: s?.city ?? '',
    emirate: s?.emirate ?? '',
    countryCode: s?.countryCode ?? 'AE',
    isVatRegistered: s?.isVatRegistered ?? false,
    trn: s?.trn ?? '',
    paymentTermsDays: String(s?.paymentTermsDays ?? 0),
    notes: s?.notes ?? '',
  };
}

const FIELDS = ['name', 'phone', 'email', 'trn', 'countryCode', 'paymentTermsDays'] as const;

/** New supplier / edit: contact details, VAT registration with the TRN, payment terms. */
export function SupplierDialog(props: {
  supplier: SupplierDetail | null;
  onReload?: () => Promise<SupplierDetail | null>;
  onClose: () => void;
  onSaved: (supplier: SupplierDetail) => void;
}) {
  const { t } = useTranslation(['parties', 'masterdata']);
  const errorText = useErrorText();
  const serverFieldError = useServerFieldError();
  const toast = useToast();
  const emirates = useEmirateOptions();
  const [base, setBase] = useState(props.supplier);
  const [form, setForm] = useState<Form>(() => formOf(props.supplier));
  const [local, setLocal] = useState<FieldErrors>({});
  const [reloading, setReloading] = useState(false);

  const save = useSave(
    (api, body: CreateSupplierRequest | UpdateSupplierRequest, key) =>
      base
        ? api.put<SupplierDetail>(supplierPath(base.id), body, { idempotencyKey: key })
        : api.post<SupplierDetail>('/api/v1/suppliers', body, { idempotencyKey: key }),
    {
      invalidate: [MD_KEYS.suppliers],
      onSuccess: (saved) => {
        toast(t('masterdata:saved'));
        props.onSaved(saved);
      },
    },
  );
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const errors: FieldErrors = { ...serverFieldError(save.error, FIELDS), ...local };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: FieldErrors = {};
    if (!form.name.trim()) found.name = t('masterdata:fields.required');
    if (form.phone.trim() && !normalizePhone(form.phone)) {
      found.phone = t('masterdata:fields.invalid_phone');
    }
    if (form.email.trim() && !EMAIL.test(form.email.trim())) {
      found.email = t('masterdata:fields.invalid_email');
    }
    if (form.isVatRegistered && !normalizeTrn(form.trn)) {
      found.trn = t('masterdata:fields.invalid_trn');
    }
    const country = form.countryCode.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) found.countryCode = t('parties:suppliers.countryInvalid');
    const termsText = asciiDigits(form.paymentTermsDays.trim());
    const days = /^\d{1,3}$/.test(termsText) ? Number(termsText) : -1;
    if (days < 0 || days > 365) found.paymentTermsDays = t('parties:credit.termsInvalid');
    setLocal(found);
    if (Object.keys(found).length > 0) return;
    const body: CreateSupplierRequest = {
      name: form.name.trim(),
      nameAlt: optional(form.nameAlt),
      phone: optional(form.phone),
      email: optional(form.email),
      addressLine: optional(form.addressLine),
      city: optional(form.city),
      emirate: form.emirate || null,
      countryCode: country,
      isVatRegistered: form.isVatRegistered,
      trn: form.isVatRegistered ? form.trn.trim() : null,
      paymentTermsDays: days,
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

  return (
    <Dialog
      isOpen
      onClose={props.onClose}
      title={base ? t('parties:suppliers.editTitle') : t('parties:suppliers.newTitle')}
      wide
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        {failure !== null && isStale(failure) && (
          <StaleNotice onReload={() => void reload()} busy={reloading} />
        )}
        {failure !== null && !isStale(failure) && !isFieldError(failure, FIELDS) && (
          <Alert>{errorText(failure)}</Alert>
        )}
        <div className={styles.grid2}>
          <TextField
            label={t('parties:suppliers.name')}
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
            autoComplete="off"
            placeholder={t('parties:form.phoneHint')}
            error={errors.phone}
          />
          <TextField
            label={t('parties:form.email')}
            value={form.email}
            onChange={(email) => set({ email })}
            ltr
            autoComplete="off"
            error={errors.email}
          />
        </div>
        <TextField
          label={t('parties:form.address')}
          value={form.addressLine}
          onChange={(addressLine) => set({ addressLine })}
          autoComplete="off"
        />
        <div className={styles.grid3}>
          <TextField
            label={t('parties:form.city')}
            value={form.city}
            onChange={(city) => set({ city })}
            autoComplete="off"
          />
          <SelectField
            id="supplier-emirate"
            label={t('parties:form.emirate')}
            value={form.emirate}
            options={emirates}
            onChange={(emirate) => set({ emirate: emirate as Emirate | '' })}
          />
          <TextField
            label={t('parties:suppliers.countryCode')}
            value={form.countryCode}
            onChange={(countryCode) => set({ countryCode })}
            ltr
            maxLength={2}
            autoComplete="off"
            hint={t('parties:suppliers.countryHint')}
            error={errors.countryCode}
          />
        </div>
        <VatBox
          isVatRegistered={form.isVatRegistered}
          onVatChange={(isVatRegistered) => set({ isVatRegistered })}
          trn={form.trn}
          onTrnChange={(trn) => set({ trn })}
          trnError={errors.trn}
        />
        <div className={styles.grid2}>
          <TextField
            label={t('parties:suppliers.terms')}
            value={form.paymentTermsDays}
            onChange={(paymentTermsDays) => set({ paymentTermsDays })}
            ltr
            inputMode="numeric"
            maxLength={3}
            hint={t('parties:suppliers.termsHint')}
            error={errors.paymentTermsDays}
          />
          <TextField
            label={t('parties:form.notes')}
            value={form.notes}
            onChange={(notes) => set({ notes })}
            multiline
          />
        </div>
        <Note>{t('parties:suppliers.uniqueNote')}</Note>
        <DialogFooter>
          <Button onPress={props.onClose}>{t('masterdata:actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {t('parties:suppliers.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
