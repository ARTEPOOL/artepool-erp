/** Customers from the server: the searchable list (page by page) and one customer's details. */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { CustomerDetail, CustomersResponse } from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { useCan } from '../auth/context';
import { MD_KEYS } from '../masterdata/refs';
import { PAGE_SIZE } from './parts';

/** The design's filter buttons ("With balance" arrives with balances in M4). */
export const CUSTOMER_FILTERS = ['active', 'vat', 'nv', 'inactive'] as const;
export type CustomerFilter = (typeof CUSTOMER_FILTERS)[number];

function listParams(q: string, filter: CustomerFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (q.trim()) p.set('q', q.trim());
  p.set('status', filter === 'inactive' ? 'inactive' : 'active');
  if (filter === 'vat') p.set('vat', 'registered');
  if (filter === 'nv') p.set('vat', 'not_registered');
  p.set('pageSize', String(PAGE_SIZE));
  return p;
}

export function useCustomerList(q: string, filter: CustomerFilter) {
  const api = useApi();
  const can = useCan();
  const params = listParams(q, filter);
  return useInfiniteQuery({
    queryKey: [...MD_KEYS.customers, 'list', params.toString()],
    enabled: can('customers.view'),
    initialPageParam: 1,
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      p.set('page', String(pageParam));
      return api.get<CustomersResponse>(`/api/v1/customers?${p.toString()}`);
    },
    getNextPageParam: (last, pages) =>
      pages.reduce((n, page) => n + page.customers.length, 0) < last.total
        ? pages.length + 1
        : undefined,
  });
}

export function useCustomer(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.customer(id ?? ''),
    enabled: id !== null,
    queryFn: () => api.get<CustomerDetail>(`/api/v1/customers/${id}`),
  });
}

export const customerPath = (id: string, action = '') => `/api/v1/customers/${id}${action}`;
