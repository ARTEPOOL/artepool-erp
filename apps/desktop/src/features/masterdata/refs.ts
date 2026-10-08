/**
 * Master data the screens read from the server, with one query key each so a save can refresh
 * exactly what it changed. The server checks every permission again.
 */
import { useQuery, type QueryKey } from '@tanstack/react-query';
import type {
  AccountsResponse,
  BusinessLineItem,
  CategoryItem,
  CompanyResponse,
  UnitItem,
  VatResponse,
} from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { useCan } from '../auth/context';

export const MD_KEYS = {
  items: ['md', 'items'] as QueryKey,
  item: (id: string) => ['md', 'items', id] as QueryKey,
  customers: ['md', 'customers'] as QueryKey,
  customer: (id: string) => ['md', 'customers', id] as QueryKey,
  suppliers: ['md', 'suppliers'] as QueryKey,
  supplier: (id: string) => ['md', 'suppliers', id] as QueryKey,
  units: ['md', 'units'] as QueryKey,
  categories: ['md', 'categories'] as QueryKey,
  vat: ['md', 'vat'] as QueryKey,
  businessLines: ['md', 'business-lines'] as QueryKey,
  accounts: ['md', 'accounts'] as QueryKey,
  periods: ['md', 'periods'] as QueryKey,
  series: ['md', 'series'] as QueryKey,
  company: ['md', 'company'] as QueryKey,
  logo: ['md', 'logo'] as QueryKey,
  technicians: ['md', 'technicians'] as QueryKey,
  paymentMethods: ['md', 'payment-methods'] as QueryKey,
  warehouses: ['md', 'warehouses'] as QueryKey,
  reasonCodes: ['md', 'reason-codes'] as QueryKey,
};

export function useVat() {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.vat,
    queryFn: () => api.get<VatResponse>('/api/v1/settings/vat'),
  });
}

export function useUnits() {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.units,
    queryFn: async () => (await api.get<{ units: UnitItem[] }>('/api/v1/units')).units,
  });
}

export function useCategories() {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.categories,
    queryFn: async () =>
      (await api.get<{ categories: CategoryItem[] }>('/api/v1/item-categories')).categories,
  });
}

export function useBusinessLines() {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.businessLines,
    queryFn: async () =>
      (await api.get<{ businessLines: BusinessLineItem[] }>('/api/v1/business-lines'))
        .businessLines,
  });
}

/** The chart of accounts and its event links (needs `ledger.view`). */
export function useAccounts() {
  const api = useApi();
  const can = useCan();
  return useQuery({
    queryKey: MD_KEYS.accounts,
    queryFn: () => api.get<AccountsResponse>('/api/v1/accounts'),
    enabled: can('ledger.view'),
  });
}

export function useCompany() {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.company,
    queryFn: () => api.get<CompanyResponse>('/api/v1/company'),
  });
}

/** Name in the screen's language for anything with `nameAr` / `nameEn`. */
export const localName =
  (language: string) =>
  (thing: { nameAr: string; nameEn: string }): string =>
    language === 'en' ? thing.nameEn : thing.nameAr;
