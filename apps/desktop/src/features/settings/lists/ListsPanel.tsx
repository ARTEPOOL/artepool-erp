import { useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs } from '../../../ui';
import { useCan } from '../../auth/context';
import { NoAccess, PanelHeader } from '../parts';
import { BusinessLinesTab, PaymentMethodsTab, ReasonCodesTab } from './AccountListTabs';
import { CategoriesTab, TechniciansTab, UnitsTab } from './ItemListTabs';
import { LabelSizesTab } from './LabelSizesTab';
import { VatTab } from './VatTab';
import { WarehousesTab } from './WarehousesTab';

type TabId =
  | 'units'
  | 'categories'
  | 'vat'
  | 'paymentMethods'
  | 'warehouses'
  | 'technicians'
  | 'businessLines'
  | 'reasons'
  | 'labelSizes';

/** Each tab and the permission that opens it (the server checks again on every call). */
const TABS: { id: TabId; permission: string | null; component: ComponentType }[] = [
  { id: 'units', permission: 'items.manage', component: UnitsTab },
  { id: 'categories', permission: 'items.manage', component: CategoriesTab },
  // Everyone who opens Lists sees the VAT categories; only the owner changes a rate (0033).
  { id: 'vat', permission: null, component: VatTab },
  { id: 'paymentMethods', permission: 'payment_methods.manage', component: PaymentMethodsTab },
  { id: 'warehouses', permission: 'warehouses.manage', component: WarehousesTab },
  { id: 'technicians', permission: 'technicians.manage', component: TechniciansTab },
  { id: 'businessLines', permission: 'accounts.manage', component: BusinessLinesTab },
  { id: 'reasons', permission: 'system.settings.edit', component: ReasonCodesTab },
  // Everyone sees the label sizes; only the owner adds or changes one (0043).
  { id: 'labelSizes', permission: null, component: LabelSizesTab },
];

/** Settings → Lists (design 13 style; decision 0034). */
export function ListsPanel() {
  const { t } = useTranslation('lists');
  const can = useCan();
  const tabs = TABS.filter((tab) => tab.permission === null || can(tab.permission));
  const [chosen, setChosen] = useState<TabId | null>(null);
  // Only the lists everyone may read: this person has no list to manage here.
  if (tabs.every((tab) => tab.permission === null)) return <NoAccess />;
  const current = tabs.find((tab) => tab.id === chosen) ?? tabs[0]!;
  const Current = current.component;
  return (
    <>
      <PanelHeader title={t('title')} subtitle={t('subtitle')} />
      <Tabs
        label={t('title')}
        value={current.id}
        onChange={setChosen}
        tabs={tabs.map((tab) => ({ value: tab.id, label: t(`${tab.id}.tab`) }))}
      />
      <Current key={current.id} />
    </>
  );
}
