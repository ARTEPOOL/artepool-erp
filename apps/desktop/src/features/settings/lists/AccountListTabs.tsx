/**
 * Settings → Lists: the lists that post to an account — payment methods, lines of business and
 * reason codes (posting map rows 1–3 and 16–17). Accounts are chosen from the chart of accounts
 * (decision 0018): only active accounts that can receive postings and are not control accounts.
 */
import { useTranslation } from 'react-i18next';
import {
  ACCOUNT_TYPES,
  PAYMENT_KINDS,
  REASON_CATEGORIES,
  REASON_CATEGORIES_WITH_ACCOUNT,
  type AccountItem,
  type BusinessLineItem,
  type PaymentKind,
  type PaymentMethodItem,
  type ReasonCategory,
  type ReasonCodeItem,
} from '@artepool/shared/contracts';
import { Checkbox, Chip, Note, SelectField, Switch, TextField } from '../../../ui';
import { useCan } from '../../auth/context';
import { MD_KEYS, useAccounts, useBusinessLines } from '../../masterdata/refs';
import { ListEditor } from './ListEditor';
import {
  FieldMessage,
  isPlainAccount,
  listClasses as styles,
  parseWhole,
  useAccountLabel,
  useAccountOptions,
} from './parts';
import { usePaymentMethods, useReasonCodes } from './queries';

/** The chart, when this person may read it (`ledger.view`); else an empty list and a note. */
function useChart() {
  const can = useCan();
  const accounts = useAccounts();
  const label = useAccountLabel();
  const { t } = useTranslation('lists');
  const list: AccountItem[] = accounts.data?.accounts ?? [];
  const nameOf = (id: string | null) => {
    if (!id) return t('masterdata:none');
    const account = list.find((a) => a.id === id);
    return account ? <bdi>{label(account)}</bdi> : t('masterdata:none');
  };
  return { list, nameOf, visible: can('ledger.view') };
}

function AccountField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  accounts: AccountItem[];
  suitable: (account: AccountItem) => boolean;
  visible: boolean;
  hint: string;
  error: string | undefined;
}) {
  const { t } = useTranslation('lists');
  const options = useAccountOptions();
  return (
    <div className={styles.form}>
      {props.visible ? (
        <SelectField
          id={props.id}
          label={props.label}
          value={props.value}
          onChange={props.onChange}
          options={options(props.accounts, props.suitable, props.value)}
        />
      ) : (
        <Note>{t('accountsNeedPermission')}</Note>
      )}
      <span className={styles.muted}>{props.hint}</span>
      <FieldMessage text={props.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------------------------

type PaymentForm = {
  code: string;
  nameAr: string;
  nameEn: string;
  kind: PaymentKind;
  glAccountId: string;
  opensDrawer: boolean;
  givesChange: boolean;
  requiresReference: boolean;
  inPos: boolean;
  inOffice: boolean;
  sortOrder: string;
};

export function PaymentMethodsTab() {
  const { t } = useTranslation('lists');
  const can = useCan();
  const methods = usePaymentMethods();
  const chart = useChart();
  const assetAccount = (a: AccountItem) => isPlainAccount(a, ['asset']);
  return (
    <ListEditor<PaymentMethodItem, PaymentForm>
      section="paymentMethods"
      basePath="/api/v1/payment-methods"
      queryKey={MD_KEYS.paymentMethods}
      query={methods}
      canEdit={can('payment_methods.manage')}
      codeFixed
      invalidate={[MD_KEYS.accounts]}
      columns={[
        {
          id: 'kind',
          header: t('paymentMethods.kind'),
          cell: (m) => t(`paymentMethods.kinds.${m.kind}`),
        },
        {
          id: 'account',
          header: t('paymentMethods.account'),
          cell: (m) => chart.nameOf(m.glAccountId),
        },
        {
          id: 'where',
          header: t('paymentMethods.where'),
          cell: (m) => (
            <span className={styles.chips}>
              {m.inPos && <Chip>{t('paymentMethods.inPos')}</Chip>}
              {m.inOffice && <Chip>{t('paymentMethods.inOffice')}</Chip>}
            </span>
          ),
        },
        {
          id: 'sort',
          header: t('field.sortOrder'),
          num: true,
          cell: (m) => <bdi>{m.sortOrder}</bdi>,
        },
      ]}
      toForm={(m) => ({
        code: m?.code ?? '',
        nameAr: m?.nameAr ?? '',
        nameEn: m?.nameEn ?? '',
        kind: m?.kind ?? 'cash',
        glAccountId: m?.glAccountId ?? '',
        opensDrawer: m?.opensDrawer ?? false,
        givesChange: m?.givesChange ?? false,
        requiresReference: m?.requiresReference ?? false,
        inPos: m?.inPos ?? true,
        inOffice: m?.inOffice ?? true,
        sortOrder: String(m?.sortOrder ?? 0),
      })}
      toBody={(form, editing) => ({
        ...(editing ? {} : { kind: form.kind }),
        glAccountId: form.glAccountId,
        opensDrawer: form.opensDrawer,
        givesChange: form.kind === 'cash' && form.givesChange,
        requiresReference: form.requiresReference,
        inPos: form.inPos,
        inOffice: form.inOffice,
        sortOrder: parseWhole(form.sortOrder, 999) ?? 0,
      })}
      check={(form) => {
        const problems: Record<string, string> = {};
        if (!form.glAccountId) problems.glAccountId = t('masterdata:fields.required');
        if (!form.inPos && !form.inOffice) problems.where = t('paymentMethods.whereRule');
        if (parseWhole(form.sortOrder, 999) === null) problems.sortOrder = t('sortOrderRule');
        return problems;
      }}
      fieldNames={['kind', 'glAccountId', 'sortOrder']}
      fields={({ form, set, editing, error }) => (
        <>
          <div className={styles.grid3}>
            <div className={styles.form}>
              <SelectField
                id="payment-kind"
                label={t('paymentMethods.kind')}
                value={form.kind}
                isDisabled={editing !== null}
                onChange={(value) => {
                  const kind = value as PaymentKind;
                  set({ kind, givesChange: kind === 'cash' && form.givesChange });
                }}
                options={PAYMENT_KINDS.map((value) => ({
                  value,
                  label: t(`paymentMethods.kinds.${value}`),
                }))}
              />
              {editing && <span className={styles.muted}>{t('paymentMethods.kindFixed')}</span>}
            </div>
            <AccountField
              id="payment-account"
              label={t('paymentMethods.account')}
              value={form.glAccountId}
              onChange={(glAccountId) => set({ glAccountId })}
              accounts={chart.list}
              suitable={assetAccount}
              visible={chart.visible}
              hint={t('paymentMethods.accountHint')}
              error={error('glAccountId')}
            />
            <TextField
              label={t('field.sortOrder')}
              value={form.sortOrder}
              onChange={(sortOrder) => set({ sortOrder })}
              ltr
              inputMode="numeric"
              maxLength={3}
              hint={t('sortOrderHint')}
              error={error('sortOrder')}
            />
          </div>
          <div className={styles.grid2}>
            <div className={styles.switches}>
              <Switch isSelected={form.inPos} onChange={(inPos) => set({ inPos })}>
                {t('paymentMethods.inPos')}
              </Switch>
              <Switch isSelected={form.inOffice} onChange={(inOffice) => set({ inOffice })}>
                {t('paymentMethods.inOffice')}
              </Switch>
              <FieldMessage text={error('where')} />
            </div>
            <div className={styles.switches}>
              <Switch
                isSelected={form.opensDrawer}
                onChange={(opensDrawer) => set({ opensDrawer })}
              >
                {t('paymentMethods.opensDrawer')}
              </Switch>
              <Switch
                isSelected={form.kind === 'cash' && form.givesChange}
                isDisabled={form.kind !== 'cash'}
                onChange={(givesChange) => set({ givesChange })}
              >
                {t('paymentMethods.givesChange')}
              </Switch>
              <Switch
                isSelected={form.requiresReference}
                onChange={(requiresReference) => set({ requiresReference })}
              >
                {t('paymentMethods.requiresReference')}
              </Switch>
            </div>
          </div>
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Lines of business
// ---------------------------------------------------------------------------------------------

type BusinessLineForm = {
  code: string;
  nameAr: string;
  nameEn: string;
  revenueAccountId: string;
  cogsAccountId: string;
  sortOrder: string;
};

export function BusinessLinesTab() {
  const { t } = useTranslation('lists');
  const can = useCan();
  const lines = useBusinessLines();
  const chart = useChart();
  return (
    <ListEditor<BusinessLineItem, BusinessLineForm>
      section="businessLines"
      basePath="/api/v1/business-lines"
      queryKey={MD_KEYS.businessLines}
      query={lines}
      canEdit={can('accounts.manage')}
      codeFixed
      invalidate={[MD_KEYS.accounts]}
      columns={[
        {
          id: 'revenue',
          header: t('businessLines.revenueAccount'),
          cell: (l) => chart.nameOf(l.revenueAccountId),
        },
        {
          id: 'cogs',
          header: t('businessLines.cogsAccount'),
          cell: (l) => chart.nameOf(l.cogsAccountId),
        },
        {
          id: 'sort',
          header: t('field.sortOrder'),
          num: true,
          cell: (l) => <bdi>{l.sortOrder}</bdi>,
        },
      ]}
      toForm={(l) => ({
        code: l?.code ?? '',
        nameAr: l?.nameAr ?? '',
        nameEn: l?.nameEn ?? '',
        revenueAccountId: l?.revenueAccountId ?? '',
        cogsAccountId: l?.cogsAccountId ?? '',
        sortOrder: String(l?.sortOrder ?? 0),
      })}
      toBody={(form) => ({
        revenueAccountId: form.revenueAccountId,
        cogsAccountId: form.cogsAccountId,
        sortOrder: parseWhole(form.sortOrder, 999) ?? 0,
      })}
      check={(form) => {
        const problems: Record<string, string> = {};
        if (!form.revenueAccountId) problems.revenueAccountId = t('masterdata:fields.required');
        if (!form.cogsAccountId) problems.cogsAccountId = t('masterdata:fields.required');
        if (parseWhole(form.sortOrder, 999) === null) problems.sortOrder = t('sortOrderRule');
        return problems;
      }}
      fieldNames={['revenueAccountId', 'cogsAccountId', 'sortOrder']}
      fields={({ form, set, error }) => (
        <div className={styles.grid3}>
          <AccountField
            id="line-revenue"
            label={t('businessLines.revenueAccount')}
            value={form.revenueAccountId}
            onChange={(revenueAccountId) => set({ revenueAccountId })}
            accounts={chart.list}
            suitable={(a) => isPlainAccount(a, ['revenue'])}
            visible={chart.visible}
            hint={t('businessLines.revenueHint')}
            error={error('revenueAccountId')}
          />
          <AccountField
            id="line-cogs"
            label={t('businessLines.cogsAccount')}
            value={form.cogsAccountId}
            onChange={(cogsAccountId) => set({ cogsAccountId })}
            accounts={chart.list}
            suitable={(a) => isPlainAccount(a, ['expense'])}
            visible={chart.visible}
            hint={t('businessLines.cogsHint')}
            error={error('cogsAccountId')}
          />
          <TextField
            label={t('field.sortOrder')}
            value={form.sortOrder}
            onChange={(sortOrder) => set({ sortOrder })}
            ltr
            inputMode="numeric"
            maxLength={3}
            hint={t('sortOrderHint')}
            error={error('sortOrder')}
          />
        </div>
      )}
      note={<Note>{t('businessLines.note')}</Note>}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------------------------

type ReasonForm = {
  code: string;
  nameAr: string;
  nameEn: string;
  category: ReasonCategory;
  requiresNote: boolean;
  glAccountId: string;
};

const needsAccount = (category: ReasonCategory) =>
  REASON_CATEGORIES_WITH_ACCOUNT.includes(category);

const byCategoryThenCode = (a: ReasonCodeItem, b: ReasonCodeItem) =>
  REASON_CATEGORIES.indexOf(a.category) - REASON_CATEGORIES.indexOf(b.category) ||
  a.code.localeCompare(b.code);

export function ReasonCodesTab() {
  const { t } = useTranslation('lists');
  const can = useCan();
  const reasons = useReasonCodes();
  const chart = useChart();
  return (
    <ListEditor<ReasonCodeItem, ReasonForm>
      section="reasons"
      basePath="/api/v1/reason-codes"
      queryKey={MD_KEYS.reasonCodes}
      query={reasons}
      canEdit={can('system.settings.edit')}
      codeFixed
      invalidate={[MD_KEYS.accounts]}
      order={(rows) => [...rows].sort(byCategoryThenCode).map((row) => ({ row, depth: 0 }))}
      columns={[
        {
          id: 'category',
          header: t('reasons.category'),
          cell: (r) => t(`reasons.categories.${r.category}`),
        },
        {
          id: 'account',
          header: t('reasons.account'),
          cell: (r) => chart.nameOf(r.glAccountId),
        },
        {
          id: 'note',
          header: t('reasons.requiresNote'),
          cell: (r) => (r.requiresNote ? t('masterdata:yes') : t('masterdata:no')),
        },
      ]}
      toForm={(r) => ({
        code: r?.code ?? '',
        nameAr: r?.nameAr ?? '',
        nameEn: r?.nameEn ?? '',
        category: r?.category ?? 'other',
        requiresNote: r?.requiresNote ?? false,
        glAccountId: r?.glAccountId ?? '',
      })}
      toBody={(form, editing) => ({
        ...(editing ? {} : { category: form.category }),
        requiresNote: form.requiresNote,
        glAccountId: needsAccount(form.category) ? form.glAccountId || null : null,
      })}
      check={(form): Record<string, string> =>
        needsAccount(form.category) && !form.glAccountId
          ? { glAccountId: t('reasons.accountRequired') }
          : {}
      }
      fieldNames={['category', 'glAccountId']}
      fields={({ form, set, editing, error }) => (
        <div className={styles.grid2}>
          <div className={styles.form}>
            <SelectField
              id="reason-category"
              label={t('reasons.category')}
              value={form.category}
              isDisabled={editing !== null}
              onChange={(value) => set({ category: value as ReasonCategory })}
              options={REASON_CATEGORIES.map((value) => ({
                value,
                label: t(`reasons.categories.${value}`),
              }))}
            />
            {editing && <span className={styles.muted}>{t('reasons.categoryFixed')}</span>}
            <Checkbox
              isSelected={form.requiresNote}
              onChange={(requiresNote) => set({ requiresNote })}
            >
              {t('reasons.requiresNoteLong')}
            </Checkbox>
          </div>
          {needsAccount(form.category) && (
            <AccountField
              id="reason-account"
              label={t('reasons.account')}
              value={form.glAccountId}
              onChange={(glAccountId) => set({ glAccountId })}
              accounts={chart.list}
              suitable={(a) => isPlainAccount(a, ACCOUNT_TYPES)}
              visible={chart.visible}
              hint={t(`reasons.accountHint.${form.category === 'paid_in' ? 'in' : 'out'}`)}
              error={error('glAccountId')}
            />
          )}
        </div>
      )}
      note={<Note>{t('reasons.note')}</Note>}
    />
  );
}
