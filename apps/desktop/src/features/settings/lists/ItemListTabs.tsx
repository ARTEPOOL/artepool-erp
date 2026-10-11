/** Settings → Lists: units, item categories and technicians (decision 0034). */
import { useTranslation } from 'react-i18next';
import type { CategoryItem, TechnicianItem, UnitItem } from '@artepool/shared/contracts';
import { asciiDigits, formatPhone } from '@artepool/shared';
import { Note, SelectField, TextField } from '../../../ui';
import { useCan } from '../../auth/context';
import { localName, MD_KEYS, useCategories, useUnits } from '../../masterdata/refs';
import { ListEditor } from './ListEditor';
import { listClasses as styles, parseWhole } from './parts';
import { useTechnicians } from './queries';
import { branchOf, indent, treeOrder } from './tree';

const DECIMALS = ['0', '1', '2', '3'] as const;

/** Units: the decimals a quantity may have (pieces 0, kilograms 3); the code never changes. */
export function UnitsTab() {
  const { t } = useTranslation('lists');
  const can = useCan();
  const units = useUnits();
  return (
    <ListEditor<
      UnitItem,
      { code: string; nameAr: string; nameEn: string; decimals: string; einvoiceCode: string }
    >
      section="units"
      basePath="/api/v1/units"
      queryKey={MD_KEYS.units}
      query={units}
      canEdit={can('items.manage')}
      codeFixed
      columns={[
        {
          id: 'decimals',
          header: t('units.decimals'),
          num: true,
          cell: (unit) => <bdi>{unit.decimals}</bdi>,
        },
        {
          id: 'einvoice',
          header: t('units.einvoiceCode'),
          cell: (unit) => <bdi>{unit.einvoiceCode ?? t('masterdata:none')}</bdi>,
        },
      ]}
      toForm={(unit) => ({
        code: unit?.code ?? '',
        nameAr: unit?.nameAr ?? '',
        nameEn: unit?.nameEn ?? '',
        decimals: String(unit?.decimals ?? 0),
        einvoiceCode: unit?.einvoiceCode ?? '',
      })}
      toBody={(form) => ({
        decimals: Number(form.decimals),
        einvoiceCode: form.einvoiceCode.trim().toUpperCase() || null,
      })}
      check={(form): Record<string, string> => {
        const code = form.einvoiceCode.trim().toUpperCase();
        return code && !/^[A-Z0-9]{1,3}$/.test(code)
          ? { einvoiceCode: t('units.einvoiceRule') }
          : {};
      }}
      fieldNames={['decimals', 'einvoiceCode']}
      fields={({ form, set, error }) => (
        <div className={styles.grid2}>
          <SelectField
            id="unit-decimals"
            label={t('units.decimals')}
            value={form.decimals}
            onChange={(decimals) => set({ decimals })}
            options={DECIMALS.map((value) => ({
              value,
              label: t(`units.decimalsOption.${value}`),
            }))}
          />
          <TextField
            label={t('units.einvoiceCode')}
            value={form.einvoiceCode}
            onChange={(einvoiceCode) => set({ einvoiceCode })}
            ltr
            maxLength={3}
            hint={t('units.einvoiceHint')}
            error={error('einvoiceCode')}
          />
        </div>
      )}
      note={<Note>{t('units.note')}</Note>}
      invalidate={[MD_KEYS.items]}
    />
  );
}

type CategoryForm = {
  code: string;
  nameAr: string;
  nameEn: string;
  parentId: string;
  sortOrder: string;
};

const byOrderThenCode = (a: CategoryItem, b: CategoryItem) =>
  a.sortOrder - b.sortOrder || a.code.localeCompare(b.code);

/** Item categories: a tree (a category may sit under another one). */
export function CategoriesTab() {
  const { t, i18n } = useTranslation('lists');
  const can = useCan();
  const categories = useCategories();
  const nameOf = localName(i18n.language);
  const all = categories.data ?? [];
  return (
    <ListEditor<CategoryItem, CategoryForm>
      section="categories"
      basePath="/api/v1/item-categories"
      queryKey={MD_KEYS.categories}
      query={categories}
      canEdit={can('items.manage')}
      codeFixed={false}
      order={(rows) => treeOrder(rows, byOrderThenCode)}
      columns={[
        {
          id: 'parent',
          header: t('categories.parent'),
          cell: (category) => {
            const parent = all.find((c) => c.id === category.parentId);
            return parent ? nameOf(parent) : t('categories.topLevel');
          },
        },
        {
          id: 'sort',
          header: t('field.sortOrder'),
          num: true,
          cell: (category) => <bdi>{category.sortOrder}</bdi>,
        },
      ]}
      toForm={(category) => ({
        code: category?.code ?? '',
        nameAr: category?.nameAr ?? '',
        nameEn: category?.nameEn ?? '',
        parentId: category?.parentId ?? '',
        sortOrder: String(category?.sortOrder ?? 0),
      })}
      toBody={(form) => ({
        parentId: form.parentId || null,
        sortOrder: parseWhole(form.sortOrder, 999) ?? 0,
      })}
      check={(form): Record<string, string> =>
        parseWhole(form.sortOrder, 999) === null ? { sortOrder: t('sortOrderRule') } : {}
      }
      fieldNames={['parentId', 'sortOrder']}
      fields={({ form, set, editing, error }) => {
        const blocked = editing ? branchOf(all, editing.id) : new Set<string>();
        const options = treeOrder(all, byOrderThenCode)
          .filter(({ row }) => (row.isActive || row.id === form.parentId) && !blocked.has(row.id))
          .map(({ row, depth }) => ({ value: row.id, label: indent(depth, nameOf(row)) }));
        return (
          <div className={styles.grid2}>
            <SelectField
              id="category-parent"
              label={t('categories.parent')}
              value={form.parentId}
              onChange={(parentId) => set({ parentId })}
              options={[{ value: '', label: t('categories.topLevel') }, ...options]}
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
        );
      }}
    />
  );
}

/** Technicians: the people who do the service jobs (a user link comes later). */
export function TechniciansTab() {
  const { t } = useTranslation('lists');
  const can = useCan();
  const technicians = useTechnicians(can('technicians.manage'));
  return (
    <ListEditor<TechnicianItem, { code: string; nameAr: string; nameEn: string; phone: string }>
      section="technicians"
      basePath="/api/v1/technicians"
      queryKey={MD_KEYS.technicians}
      query={technicians}
      canEdit={can('technicians.manage')}
      codeFixed={false}
      columns={[
        {
          id: 'phone',
          header: t('technicians.phone'),
          cell: (tech) => <bdi>{tech.phone ? formatPhone(tech.phone) : t('masterdata:none')}</bdi>,
        },
      ]}
      toForm={(tech) => ({
        code: tech?.code ?? '',
        nameAr: tech?.nameAr ?? '',
        nameEn: tech?.nameEn ?? '',
        phone: tech?.phone ? formatPhone(tech.phone) : '',
      })}
      toBody={(form, editing) => ({
        phone: asciiDigits(form.phone.trim()) || null,
        userId: editing?.userId ?? null,
      })}
      fieldNames={['phone']}
      fields={({ form, set, error }) => (
        <div className={styles.grid2}>
          <TextField
            label={t('technicians.phone')}
            value={form.phone}
            onChange={(phone) => set({ phone })}
            ltr
            maxLength={40}
            hint={t('technicians.phoneHint')}
            error={error('phone')}
          />
        </div>
      )}
      invalidate={[MD_KEYS.warehouses]}
    />
  );
}
