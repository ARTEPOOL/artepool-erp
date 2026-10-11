import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, RefreshCw, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { CategoryItem, ItemDetail, ItemType } from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { useApi, useSave } from '../../api/hooks';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  IconButton,
  iconClass,
  Note,
  Segmented,
  SelectField,
  Switch,
  TextField,
  useToast,
  type SelectOption,
} from '../../ui';
import { errorField, useCan, useErrorText } from '../auth/context';
import { money, priceBoth, rate } from '../masterdata/format';
import mdStyles from '../masterdata/masterdata.module.css';
import {
  localName,
  MD_KEYS,
  useBusinessLines,
  useCategories,
  useUnits,
  useVat,
} from '../masterdata/refs';
import { itemPath, suggestCode, useItemSearch } from './api';
import {
  buildItem,
  emptyForm,
  formFromItem,
  rowKey,
  typedPrice,
  type FormErrors,
  type FormField,
  type ItemForm,
} from './form';
import { marginOf, percentText } from './margin';
import { ItemIcon, TypeLabel } from './parts';
import styles from './items.module.css';

const FORM_FIELDS: readonly FormField[] = [
  'itemType',
  'code',
  'categoryId',
  'nameAr',
  'nameEn',
  'unitId',
  'vatCategoryId',
  'price',
  'purchaseCost4dp',
  'barcodes',
  'components',
  'reorderLevelMilli',
];

/** Business rules the server names, and the field each one is about. */
const RULE_FIELDS: Record<string, FormField> = {
  PRICE_REQUIRED: 'price',
  KIT_RULE: 'components',
  ITEM_TYPE_FIXED: 'itemType',
  CODE_FIXED: 'code',
  QUANTITY_DECIMALS: 'reorderLevelMilli',
};

/** Profit per unit while typing: sale price without VAT minus the purchase price (decision 0038). */
function ProfitLine(props: {
  price: string;
  includesVat: boolean;
  cost: string;
  rateBp: number | undefined;
}) {
  const { t } = useTranslation('items');
  const sale = typedPrice(props.price);
  const cost = typedPrice(props.cost);
  if (sale === null || cost === null || props.rateBp === undefined) return null;
  const net = priceBoth(sale, props.includesVat, props.rateBp).netFils;
  const margin = marginOf(net, cost);
  return (
    <p className={styles.priceLine} data-testid="profit-line" aria-live="polite">
      {t('price.profit')}: <bdi>{money(margin.profitFils)}</bdi> {t('aed')}
      {margin.tenthsOfPercent !== null && (
        <>
          {' '}
          · <bdi>{percentText(margin.tenthsOfPercent)}</bdi>
        </>
      )}
    </p>
  );
}

function FieldMessage({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <span className={styles.fieldError}>{children}</span>;
}

/** The typed price as one unit costs the customer, updated while typing (decision 0032). */
function PriceLine(props: { text: string; includesVat: boolean; rateBp: number | undefined }) {
  const { t } = useTranslation('items');
  const value = typedPrice(props.text);
  if (value === null || props.rateBp === undefined) return null;
  const both = priceBoth(value, props.includesVat, props.rateBp);
  return (
    <p className={styles.priceLine} data-testid="price-line" aria-live="polite">
      {t('price.net')}: <bdi>{money(both.netFils)}</bdi> · {t('price.vat')}:{' '}
      <bdi>{money(both.vatFils)}</bdi> · {t('price.total')}: <bdi>{money(both.grossFils)}</bdi>{' '}
      {t('aed')}
    </p>
  );
}

/** Kit components: what one kit is made of, chosen by searching active items. */
function ComponentsEditor(props: {
  form: ItemForm;
  selfId: string | undefined;
  onChange: (components: ItemForm['components']) => void;
  error?: string;
}) {
  const { t, i18n } = useTranslation('items');
  const name = localName(i18n.language);
  const units = useUnits();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const found = useItemSearch(q);
  const taken = new Set(props.form.components.map((c) => c.itemId));
  const choices = (found.data?.items ?? []).filter(
    (i) => i.itemType !== 'bundle' && i.id !== props.selfId && !taken.has(i.id),
  );
  const rows = props.form.components;

  return (
    <fieldset className={styles.section}>
      <legend>{t('fields.components')}</legend>
      <p className={styles.muted}>{t('components.hint')}</p>
      {rows.length > 0 && (
        <ul className={styles.editList}>
          {rows.map((row, index) => {
            const unit = units.data?.find((u) => u.id === row.unitId);
            return (
              <li key={row.key} className={styles.componentRow}>
                <span className={styles.componentName}>
                  {name(row)}
                  <span className={styles.muted}>
                    {' · '}
                    <bdi>{row.code}</bdi>
                  </span>
                </span>
                <input
                  className={styles.input}
                  dir="ltr"
                  inputMode="decimal"
                  aria-label={t('components.quantityOf', { name: name(row) })}
                  value={row.qty}
                  onChange={(event) =>
                    props.onChange(
                      rows.map((r, i) => (i === index ? { ...r, qty: event.target.value } : r)),
                    )
                  }
                />
                <span className={styles.muted}>{unit ? name(unit) : ''}</span>
                <IconButton
                  aria-label={t('components.remove', { name: name(row) })}
                  onPress={() => props.onChange(rows.filter((_, i) => i !== index))}
                >
                  <X className={iconClass.sm} aria-hidden="true" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
      <label className={styles.pickSearch}>
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label={t('components.search')}
          placeholder={t('components.search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {q && (
        <ul className={styles.choices} aria-label={t('components.results')}>
          {choices.map((choice) => (
            <li key={choice.id}>
              <button
                type="button"
                onClick={() => {
                  props.onChange([
                    ...rows,
                    {
                      key: rowKey(),
                      itemId: choice.id,
                      code: choice.code,
                      nameAr: choice.nameAr,
                      nameEn: choice.nameEn,
                      unitId: choice.unitId,
                      qty: '1',
                    },
                  ]);
                  setSearch('');
                  setQ('');
                }}
              >
                <Plus className={iconClass.sm} aria-hidden="true" />
                <span>{name(choice)}</span>
                <bdi className={styles.muted}>{choice.code}</bdi>
              </button>
            </li>
          ))}
          {!found.isFetching && choices.length === 0 && (
            <li className={styles.muted}>{t('components.none')}</li>
          )}
        </ul>
      )}
      <FieldMessage>{props.error}</FieldMessage>
    </fieldset>
  );
}

/** Barcodes: several per item, one main; pack barcodes scan several units at once. */
function BarcodesEditor(props: {
  rows: ItemForm['barcodes'];
  onChange: (rows: ItemForm['barcodes']) => void;
  error?: string;
}) {
  const { t } = useTranslation('items');
  const { rows } = props;
  const update = (index: number, patch: Partial<ItemForm['barcodes'][number]>) =>
    props.onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  return (
    <fieldset className={styles.section}>
      <legend>{t('fields.barcodes')}</legend>
      {rows.length === 0 && <p className={styles.muted}>{t('detail.noBarcodes')}</p>}
      {rows.length > 0 && (
        <ul className={styles.editList}>
          {rows.map((row, index) => (
            <li key={row.key} className={styles.barcodeRow}>
              <input
                className={styles.input}
                dir="ltr"
                autoComplete="off"
                aria-label={t('barcodes.barcodeN', { n: index + 1 })}
                value={row.barcode}
                onChange={(event) => update(index, { barcode: event.target.value })}
              />
              <input
                className={styles.input}
                dir="ltr"
                inputMode="decimal"
                aria-label={t('barcodes.perScanN', { n: index + 1 })}
                title={t('barcodes.perScan')}
                value={row.qty}
                onChange={(event) => update(index, { qty: event.target.value })}
              />
              <label className={styles.radio}>
                <input
                  type="radio"
                  name="primary-barcode"
                  checked={row.isPrimary}
                  onChange={() =>
                    props.onChange(rows.map((r, i) => ({ ...r, isPrimary: i === index })))
                  }
                />
                {t('barcodes.primary')}
              </label>
              <IconButton
                aria-label={t('barcodes.removeN', { n: index + 1 })}
                onPress={() => props.onChange(rows.filter((_, i) => i !== index))}
              >
                <X className={iconClass.sm} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="ghost"
          onPress={() =>
            props.onChange([
              ...rows,
              { key: rowKey(), barcode: '', qty: '1', isPrimary: rows.length === 0 },
            ])
          }
        >
          <Plus className={iconClass.sm} aria-hidden="true" />
          {t('barcodes.add')}
        </Button>
      </div>
      <p className={styles.muted}>{t('barcodes.hint')}</p>
      <FieldMessage>{props.error}</FieldMessage>
    </fieldset>
  );
}

/** "Parent › Child" for a sub-category, so the tree reads in a flat list. */
function categoryLabel(
  all: CategoryItem[],
  category: CategoryItem,
  name: (c: CategoryItem) => string,
) {
  const parent = category.parentId ? all.find((c) => c.id === category.parentId) : undefined;
  return parent ? `${name(parent)} › ${name(category)}` : name(category);
}

/**
 * New item and Edit item (design 07, with the fields the PRD adds: type, several barcodes, kit
 * components, line of business). The code is suggested from the category and never changes after
 * the first save (decision 0037); the one sale price has its "Price includes VAT" switch (0032).
 */
export function ItemDialog(props: {
  item?: ItemDetail;
  onClose: () => void;
  onSaved: (item: ItemDetail) => void;
}) {
  const { t, i18n } = useTranslation('items');
  const tm = useTranslation('masterdata').t;
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const name = localName(i18n.language);
  const units = useUnits();
  const categories = useCategories();
  const vat = useVat();
  const lines = useBusinessLines();
  const [base, setBase] = useState<ItemDetail | undefined>(props.item);
  const isNew = base === undefined;
  const canPrice = can('prices.manage');
  const canCost = can('items.cost');
  const [form, setForm] = useState<ItemForm>(() =>
    props.item ? formFromItem(props.item) : emptyForm({ unitId: '', vatCategoryId: '' }),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [reloading, setReloading] = useState(false);
  const [showDescriptions, setShowDescriptions] = useState(
    Boolean(props.item?.descriptionAr || props.item?.descriptionEn),
  );
  const codeRequest = useRef(0);

  const set = (patch: Partial<ItemForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) {
        delete next[(key === 'reorderLevel' ? 'reorderLevelMilli' : key) as FormField];
      }
      return next;
    });
  };

  // A new item starts with the first unit and the standard VAT category (5%).
  const firstUnit = units.data?.find((u) => u.isActive)?.id;
  const standardVat = vat.data?.categories.find((c) => c.code === 'SR')?.id;
  useEffect(() => {
    if (!isNew) return;
    setForm((f) => ({
      ...f,
      unitId: f.unitId || firstUnit || '',
      vatCategoryId: f.vatCategoryId || standardVat || '',
    }));
  }, [isNew, firstUnit, standardVat]);

  const chooseCategory = (categoryId: string) => {
    set({ categoryId });
    if (!isNew || !categoryId) return;
    const request = ++codeRequest.current;
    suggestCode(api, categoryId).then(
      (code) => {
        if (request === codeRequest.current) set({ code });
      },
      () => undefined,
    );
  };

  const save = useSave(
    (a, input: { body: ReturnType<typeof buildItem>['body']; code: string }, key) =>
      base
        ? a.put<ItemDetail>(
            itemPath(base.id),
            { ...input.body, rowVersion: base.rowVersion },
            { idempotencyKey: key },
          )
        : a.post<ItemDetail>(
            '/api/v1/items',
            { ...input.body, code: input.code },
            { idempotencyKey: key },
          ),
    {
      invalidate: [MD_KEYS.items],
      onSuccess: (saved) => {
        queryClient.setQueryData(MD_KEYS.item(saved.id), saved);
        toast(tm('saved'));
        props.onSaved(saved);
      },
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const built = buildItem(form, {
      isNew,
      units: units.data ?? [],
      canPrice,
      canCost,
      original: base,
    });
    setErrors(built.errors);
    setFailure(null);
    if (!built.body) return;
    save.mutate({ body: built.body, code: built.code }, { onError: setFailure });
  };

  /** Someone else saved first: load their version and start again from it. */
  const reload = async () => {
    if (!base) return;
    setReloading(true);
    try {
      const fresh = await api.get<ItemDetail>(itemPath(base.id));
      queryClient.setQueryData(MD_KEYS.item(base.id), fresh);
      void queryClient.invalidateQueries({ queryKey: MD_KEYS.items });
      setBase(fresh);
      setForm(formFromItem(fresh));
      setErrors({});
      setFailure(null);
      save.reset();
    } catch (error) {
      setFailure(error);
    } finally {
      setReloading(false);
    }
  };

  // A refusal about one field is shown under that field; anything else above the form.
  const stale = failure instanceof ApiError && failure.code === 'STALE_VERSION';
  let serverField: { field: FormField; text: string } | null = null;
  if (failure !== null && !stale) {
    const named = errorField(failure);
    const rule = failure instanceof ApiError ? failure.details.rule : undefined;
    if (named && FORM_FIELDS.includes(named.field as FormField)) {
      const key = `masterdata:fields.${named.code}`;
      serverField = {
        field: named.field as FormField,
        text: i18n.exists(key) ? t(key) : tm('fields.invalid'),
      };
    } else if (typeof rule === 'string' && RULE_FIELDS[rule]) {
      serverField = { field: RULE_FIELDS[rule], text: errorText(failure) };
    }
  }
  const fieldText = (field: FormField): string | undefined => {
    const key = errors[field];
    if (key) return t(key);
    return serverField?.field === field ? serverField.text : undefined;
  };

  // Options: active records, plus the current one if it has been deactivated since.
  const allCategories = categories.data ?? [];
  const keep = <T extends { id: string; isActive: boolean }>(list: T[], current: string) =>
    list.filter((x) => x.isActive || x.id === current);
  const choose: SelectOption = { value: '', label: t('dialog.choose') };
  const categoryOptions = [
    ...(form.categoryId ? [] : [choose]),
    ...keep(allCategories, form.categoryId).map((c) => ({
      value: c.id,
      label: categoryLabel(allCategories, c, name),
    })),
  ];
  const unitOptions = [
    ...(form.unitId ? [] : [choose]),
    ...keep(units.data ?? [], form.unitId).map((u) => ({ value: u.id, label: name(u) })),
  ];
  const vatOptions = [
    ...(form.vatCategoryId ? [] : [choose]),
    ...(vat.data?.categories ?? []).map((c) => ({
      value: c.id,
      label: `${name(c)} (${rate(c.rateBp)})`,
    })),
  ];
  const lineOptions = [
    { value: '', label: t('dialog.noBusinessLine') },
    ...keep(lines.data ?? [], form.businessLineId).map((l) => ({ value: l.id, label: name(l) })),
  ];
  const rateBp = vat.data?.categories.find((c) => c.id === form.vatCategoryId)?.rateBp;
  const unit = units.data?.find((u) => u.id === form.unitId);
  const typeFixed = Boolean(base?.inUse);
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <Dialog
      isOpen
      onClose={props.onClose}
      title={isNew ? t('dialog.newTitle') : t('dialog.editTitle')}
      wide
      dismissable={false}
    >
      <form onSubmit={submit} noValidate className={mdStyles.form}>
        {stale && (
          <Alert tone="warn">
            <div className={styles.staleRow}>
              <span>{tm('stale')}</span>
              <Button busy={reloading} onPress={() => void reload()}>
                <RefreshCw className={iconClass.sm} aria-hidden="true" />
                {tm('actions.reload')}
              </Button>
            </div>
          </Alert>
        )}
        {failure !== null && !stale && !serverField && <Alert>{errorText(failure)}</Alert>}
        {hasErrors && <Alert>{t('dialog.fixErrors')}</Alert>}

        <div className={styles.field}>
          <span className={styles.label}>{t('fields.type')}</span>
          {typeFixed ? (
            <div className={styles.fixedType}>
              <span className={styles.typeChip}>
                <ItemIcon type={form.itemType} />
                <TypeLabel type={form.itemType} />
              </span>
              <Note>
                {t(`dialog.typeFixed.${base?.inUse ?? ''}`, {
                  defaultValue: t('dialog.typeFixedOther'),
                })}
              </Note>
            </div>
          ) : (
            <Segmented<ItemType>
              label={t('fields.type')}
              value={form.itemType}
              onChange={(itemType) => set({ itemType })}
              options={(['stock', 'service', 'bundle'] as const).map((type) => ({
                value: type,
                label: t(`types.${type}`),
                icon: <ItemIcon type={type} />,
              }))}
            />
          )}
          <FieldMessage>{fieldText('itemType')}</FieldMessage>
        </div>

        <div className={mdStyles.grid2}>
          <div className={styles.field}>
            <SelectField
              id="item-category"
              label={t('fields.category')}
              value={form.categoryId}
              options={categoryOptions}
              onChange={chooseCategory}
            />
            <FieldMessage>{fieldText('categoryId')}</FieldMessage>
          </div>
          <TextField
            label={t('fields.code')}
            value={form.code}
            onChange={(code) => set({ code })}
            ltr
            autoComplete="off"
            maxLength={32}
            isRequired={isNew}
            isDisabled={!isNew}
            hint={isNew ? t('dialog.codeHint') : t('dialog.codeFixed')}
            error={fieldText('code')}
          />
          <TextField
            label={t('fields.nameAr')}
            value={form.nameAr}
            onChange={(nameAr) => set({ nameAr })}
            isRequired
            maxLength={200}
            error={fieldText('nameAr')}
          />
          <TextField
            label={t('fields.nameEn')}
            value={form.nameEn}
            onChange={(nameEn) => set({ nameEn })}
            ltr
            isRequired
            maxLength={200}
            error={fieldText('nameEn')}
          />
        </div>

        {showDescriptions ? (
          <div className={mdStyles.grid2}>
            <TextField
              label={t('fields.descriptionAr')}
              value={form.descriptionAr}
              onChange={(descriptionAr) => set({ descriptionAr })}
              multiline
              maxLength={1000}
            />
            <TextField
              label={t('fields.descriptionEn')}
              value={form.descriptionEn}
              onChange={(descriptionEn) => set({ descriptionEn })}
              multiline
              ltr
              maxLength={1000}
            />
          </div>
        ) : (
          <div>
            <Button variant="ghost" onPress={() => setShowDescriptions(true)}>
              <Plus className={iconClass.sm} aria-hidden="true" />
              {t('dialog.addDescriptions')}
            </Button>
          </div>
        )}

        <div className={mdStyles.grid3}>
          <div className={styles.field}>
            <SelectField
              id="item-unit"
              label={t('fields.unit')}
              value={form.unitId}
              options={unitOptions}
              onChange={(unitId) => set({ unitId })}
            />
            <FieldMessage>{fieldText('unitId')}</FieldMessage>
          </div>
          <div className={styles.field}>
            <SelectField
              id="item-vat"
              label={t('fields.vatCategory')}
              value={form.vatCategoryId}
              options={vatOptions}
              onChange={(vatCategoryId) => set({ vatCategoryId })}
            />
            <FieldMessage>{fieldText('vatCategoryId')}</FieldMessage>
          </div>
          <SelectField
            id="item-line"
            label={t('fields.businessLine')}
            value={form.businessLineId}
            options={lineOptions}
            onChange={(businessLineId) => set({ businessLineId })}
          />
        </div>

        <fieldset className={styles.section}>
          <legend>{t('dialog.priceSection')}</legend>
          <div className={mdStyles.grid2}>
            <TextField
              label={t('fields.price')}
              value={form.price}
              onChange={(price) => set({ price })}
              ltr
              inputMode="text"
              autoComplete="off"
              isRequired={form.isSellable}
              isDisabled={!canPrice}
              hint={canPrice ? t('dialog.priceHint') : t('dialog.priceLocked')}
              error={fieldText('price')}
            />
            <div className={styles.switches}>
              <Switch
                isSelected={form.includesVat}
                isDisabled={!canPrice}
                onChange={(includesVat) => set({ includesVat })}
              >
                {t('fields.includesVat')}
              </Switch>
              <Switch isSelected={form.isSellable} onChange={(isSellable) => set({ isSellable })}>
                {t('fields.forSale')}
              </Switch>
            </div>
          </div>
          <PriceLine text={form.price} includesVat={form.includesVat} rateBp={rateBp} />
          {canCost && form.itemType !== 'bundle' && (
            <>
              <div className={mdStyles.grid2}>
                <TextField
                  label={t('fields.purchaseCost')}
                  value={form.purchaseCost}
                  onChange={(purchaseCost) => set({ purchaseCost })}
                  ltr
                  inputMode="text"
                  autoComplete="off"
                  hint={t('dialog.costHint')}
                  error={fieldText('purchaseCost4dp')}
                />
              </div>
              <ProfitLine
                price={form.price}
                includesVat={form.includesVat}
                cost={form.purchaseCost}
                rateBp={rateBp}
              />
            </>
          )}
          {canCost && form.itemType === 'bundle' && <Note>{t('dialog.kitCost')}</Note>}
        </fieldset>

        {form.itemType === 'stock' && (
          <div className={mdStyles.grid2}>
            <TextField
              label={t('fields.reorderLevel')}
              value={form.reorderLevel}
              onChange={(reorderLevel) => set({ reorderLevel })}
              ltr
              inputMode="text"
              autoComplete="off"
              hint={unit ? t('dialog.reorderHint', { unit: name(unit) }) : undefined}
              error={fieldText('reorderLevelMilli')}
            />
          </div>
        )}

        <BarcodesEditor
          rows={form.barcodes}
          onChange={(barcodes) => set({ barcodes })}
          error={fieldText('barcodes')}
        />

        {form.itemType === 'bundle' && (
          <ComponentsEditor
            form={form}
            selfId={base?.id}
            onChange={(components) => set({ components })}
            error={fieldText('components')}
          />
        )}

        <DialogFooter>
          <Button onPress={props.onClose}>{tm('actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending} isDisabled={stale}>
            {t('dialog.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
