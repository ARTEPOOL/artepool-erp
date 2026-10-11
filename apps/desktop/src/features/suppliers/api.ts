/** Suppliers from the server (all calls need `suppliers.manage`). */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { SupplierDetail, SuppliersResponse } from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { useCan } from '../auth/context';
import { PAGE_SIZE } from '../customers/parts';
import { MD_KEYS } from '../masterdata/refs';

export type SupplierFilter = 'active' | 'inactive';

export function useSupplierList(q: string, filter: SupplierFilter) {
  const api = useApi();
  const can = useCan();
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  params.set('status', filter);
  params.set('pageSize', String(PAGE_SIZE));
  return useInfiniteQuery({
    queryKey: [...MD_KEYS.suppliers, 'list', params.toString()],
    enabled: can('suppliers.manage'),
    initialPageParam: 1,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      p.set('page', String(pageParam));
      return api.get<SuppliersResponse>(`/api/v1/suppliers?${p.toString()}`);
    },
    getNextPageParam: (last, pages) =>
      pages.reduce((n, page) => n + page.suppliers.length, 0) < last.total
        ? pages.length + 1
        : undefined,
  });
}

export function useSupplier(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.supplier(id ?? ''),
    enabled: id !== null,
    queryFn: () => api.get<SupplierDetail>(`/api/v1/suppliers/${id}`),
  });
}

export const supplierPath = (id: string, action = '') => `/api/v1/suppliers/${id}${action}`;
