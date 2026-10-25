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
  LabelSizesResponse,
  ReasonCodeItem,
  StockSummary,
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
  labelSizes: ['md', 'label-sizes'] as QueryKey,
  // Stock (M3): every stock save refreshes all of these.
  stock: ['stock'] as QueryKey,
  stockSummary: ['stock', 'summary'] as QueryKey,
  itemStock: (id: string) => ['stock', 'item', id] as QueryKey,
  adjustments: ['stock', 'adjustments'] as QueryKey,
  counts: ['stock', 'counts'] as QueryKey,
  count: (id: string) => ['stock', 'counts', id] as QueryKey,
  journal: ['stock', 'journal'] as QueryKey,
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

/** Reasons for stock documents, cash and notes (everyone signed in may read them). */
export function useReasonCodes() {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.reasonCodes,
    queryFn: async () =>
      (await api.get<{ reasonCodes: ReasonCodeItem[] }>('/api/v1/reason-codes')).reasonCodes,
  });
}

/** Barcode label sizes (decision 0043). */
function useLabelSizesResponse<T>(select: (response: LabelSizesResponse) => T) {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.labelSizes,
    queryFn: () => api.get<LabelSizesResponse>('/api/v1/label-sizes'),
    select,
  });
}

const pickSizes = (r: LabelSizesResponse) => r.labelSizes;
const pickMaxWidth = (r: LabelSizesResponse) => r.maxWidthMm;

export function useLabelSizes() {
  return useLabelSizesResponse(pickSizes);
}

/** The widest label the label printer's roll takes (setting labels.max_width_mm, decision 0096). */
export function useLabelMaxWidth() {
  return useLabelSizesResponse(pickMaxWidth);
}

/** The stock tiles: value (owner and accountant only), to reorder, defective, pending reviews. */
export function useStockSummary() {
  const api = useApi();
  const can = useCan();
  return useQuery({
    queryKey: MD_KEYS.stockSummary,
    queryFn: () => api.get<StockSummary>('/api/v1/stock/summary'),
    enabled: can('items.view'),
  });
}
