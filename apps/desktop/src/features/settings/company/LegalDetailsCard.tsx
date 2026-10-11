import { useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  EMIRATES,
  type CompanyProfile,
  type CompanyResponse,
  type SaveCompanyRequest,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { Button, iconClass, Note, SelectField, Switch, TextField, useToast } from '../../../ui';
import { errorField } from '../../auth/context';
import { MD_KEYS } from '../../masterdata/refs';
import { CardHead, Section, settingsClasses } from '../parts';
import styles from './company.module.css';
import {
  checkForm,
  sameForm,
  toForm,
  toRequest,
  type CompanyField,
  type CompanyForm,
} from './form';
import { isStale, SaveProblem } from './SaveProblem';

/**
 * Design 13 → Company → "Legal details": what every tax invoice prints (decision 0030). The first
 * save creates the record; every later save sends the version it started from.
 */
export function LegalDetailsCard({
  company,
  canEdit,
}: {
  company: CompanyProfile | null;
  canEdit: boolean;
}) {
  const { t } = useTranslation('setup');
  const { t: md } = useTranslation('masterdata');
  const toast = useToast();
  const queryClient = useQueryClient();
  const api = useApi();
  // `base` is the saved record the form started from; its version is what a save sends back.
  const [base, setBase] = useState(company);
  const [form, setForm] = useState<CompanyForm>(() => toForm(company));
  const [seen, setSeen] = useState(company);
  const [problems, setProblems] = useState<Partial<Record<CompanyField, string>>>({});
  const [error, setError] = useState<unknown>(null);
  const [reloading, setReloading] = useState(false);

  const dirty = !sameForm(form, toForm(base));
  // A newer copy arrived from the server: take it unless it would wipe what is being typed. If
  // only the logo changed meanwhile (same details), keep the typing and take the new version.
  if (company !== seen) {
    setSeen(company);
    if (!dirty) {
      setBase(company);
      setForm(toForm(company));
    } else if (sameForm(toForm(base), toForm(company))) {
      setBase(company);
    }
  }

  const save = useSave(
    (api, body: SaveCompanyRequest, key) =>
      api.put<CompanyProfile>('/api/v1/company', body, { idempotencyKey: key }),
    {
      invalidate: [MD_KEYS.company],
      onSuccess: (saved) => {
        setBase(saved);
        setForm(toForm(saved));
        toast(md('saved'));
      },
    },
  );

  const set = <K extends CompanyField>(field: K) => {
    return (value: CompanyForm[K]) => {
      setForm((current) => ({ ...current, [field]: value }));
      setProblems((current) => ({ ...current, [field]: undefined }));
    };
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const found = checkForm(form);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    save.mutate(toRequest(form, base?.rowVersion), { onError: setError });
  };

  const reload = async () => {
    setReloading(true);
    try {
      // Read the record itself: a failed read must not bring back the old cached version.
      const answer = await api.get<CompanyResponse>('/api/v1/company');
      queryClient.setQueryData(MD_KEYS.company, answer);
      const fresh = answer.company;
      setBase(fresh);
      setSeen(fresh);
      setForm(toForm(fresh));
      setProblems({});
      setError(null);
    } catch (caught) {
      setError(caught);
    } finally {
      setReloading(false);
    }
  };

  const serverField = errorField(error);
  // A refusal about a field on this form shows under it; anything else shows below the form.
  const isFormField = (field: string): field is CompanyField => field in form;
  const problemOf = (field: CompanyField): string | undefined => {
    const code = problems[field] ?? (serverField?.field === field ? serverField.code : undefined);
    return code ? md(`fields.${code}`, { defaultValue: md('fields.invalid') }) : undefined;
  };
  const text = (field: CompanyField & keyof typeof LIMITS, options: { ltr?: boolean } = {}) => (
    <TextField
      label={t(`company.fields.${field}`)}
      value={form[field]}
      onChange={set(field)}
      error={problemOf(field)}
      maxLength={LIMITS[field]}
      ltr={options.ltr}
      isDisabled={!canEdit}
    />
  );

  return (
    <Section index={1}>
      <form onSubmit={submit} noValidate>
        <CardHead title={t('company.legal')} />
        {!canEdit && <Note>{t('company.readOnly')}</Note>}
        {!company && canEdit && <Note>{t('company.firstSave')}</Note>}
        <div className={styles.form}>
          {text('legalNameAr')}
          {text('legalNameEn', { ltr: true })}
          {text('tradeNameAr')}
          {text('tradeNameEn', { ltr: true })}
          <div className={styles.vat}>
            <Switch
              isSelected={form.vatRegistered}
              onChange={set('vatRegistered')}
              isDisabled={!canEdit}
            >
              {t('company.fields.vatRegistered')}
            </Switch>
            <span className={settingsClasses.small}>{t('company.vatHint')}</span>
          </div>
          <TextField
            label={t('company.fields.trn')}
            value={form.trn}
            onChange={set('trn')}
            error={problemOf('trn')}
            hint={form.vatRegistered ? t('company.trnHint') : t('company.trnOff')}
            inputMode="numeric"
            maxLength={40}
            ltr
            isDisabled={!canEdit || !form.vatRegistered}
          />
          <div className={styles.wide}>{text('addressAr')}</div>
          <div className={styles.wide}>{text('addressEn', { ltr: true })}</div>
          {text('city')}
          {text('poBox', { ltr: true })}
          {text('phone', { ltr: true })}
          {text('email', { ltr: true })}
          {text('website', { ltr: true })}
          <SelectField
            id="company-emirate"
            label={t('company.fields.emirate')}
            value={form.emirate}
            onChange={(value) => set('emirate')(value as CompanyForm['emirate'])}
            isDisabled={!canEdit}
            options={[
              { value: '', label: md('none') },
              ...EMIRATES.map((value) => ({ value, label: md(`emirates.${value}`) })),
            ]}
          />
        </div>
        <SaveProblem
          error={serverField && isFormField(serverField.field) && !isStale(error) ? null : error}
          onReload={() => void reload()}
          reloading={reloading}
        />
        {canEdit && (
          <div className={settingsClasses.savebar}>
            <Note>{t('company.audited')}</Note>
            <div className={settingsClasses.tools}>
              {dirty && (
                <span className={settingsClasses.dirty} role="status">
                  {t('company.unsaved')}
                </span>
              )}
              <Button
                isDisabled={!dirty || save.isPending}
                onPress={() => {
                  setForm(toForm(base));
                  setProblems({});
                  setError(null);
                }}
              >
                {md('actions.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                busy={save.isPending}
                isDisabled={save.isPending || (!dirty && company !== null)}
              >
                <Check className={iconClass.sm} aria-hidden="true" />
                {t('company.save')}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Section>
  );
}

/** Longest text each field accepts (the server's limits). */
const LIMITS = {
  legalNameAr: 200,
  legalNameEn: 200,
  tradeNameAr: 200,
  tradeNameEn: 200,
  addressAr: 500,
  addressEn: 500,
  city: 100,
  poBox: 20,
  phone: 40,
  email: 200,
  website: 200,
} as const;
