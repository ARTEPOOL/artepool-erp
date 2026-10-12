/**
 * Server calls of the stock pages (M3): opening stock, counts and oversell reviews. Every list
 * lives under `MD_KEYS.stock`, so one refresh after a save updates all of them. The server checks
 * every permission again, and leaves out values for anyone without `stock.view_cost`.
 */
import { useQuery, type QueryKey } from '@tanstack/react-query';
import type {
  AdjustmentDetail,
  AdjustmentsResponse,
  CountDetail,
  CountsResponse,
  ItemsResponse,
} from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { MD_KEYS } from '../masterdata/refs';

export const STOCK_PATHS = {
  adjustments: '/api/v1/stock/adjustments',
  adjustment: (id: string) => `/api/v1/stock/adjustments/${id}`,
  review: (id: string) => `/api/v1/stock/adjustments/${id}/review`,
  counts: '/api/v1/stock/counts',
  count: (id: string) => `/api/v1/stock/counts/${id}`,
  countLines: (id: string) => `/api/v1/stock/counts/${id}/lines`,
  countPost: (id: string) => `/api/v1/stock/counts/${id}/post`,
  countCancel: (id: string) => `/api/v1/stock/counts/${id}/cancel`,
};

/** Every save on these pages refreshes the stock figures and the items list. */
export const STOCK_INVALIDATE: QueryKey[] = [MD_KEYS.stock, MD_KEYS.items];

/** Posted adjustments of one kind (opening, oversell), optionally by review step. */
export function useAdjustments(
  kind: 'opening' | 'oversell',
  review?: 'pending' | 'reviewed',
  enabled = true,
) {
  const api = useApi();
  const params = new URLSearchParams({ kind, pageSize: '200' });
  if (review) params.set('review', review);
  return useQuery({
    queryKey: [...MD_KEYS.adjustments, kind, review ?? 'all'] as QueryKey,
    queryFn: () => api.get<AdjustmentsResponse>(`${STOCK_PATHS.adjustments}?${params.toString()}`),
    enabled,
  });
}

/** One adjustment with its lines and journal entry number. */
export function useAdjustment(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: [...MD_KEYS.adjustments, 'one', id ?? ''] as QueryKey,
    queryFn: () => api.get<AdjustmentDetail>(STOCK_PATHS.adjustment(id ?? '')),
    enabled: id !== null,
  });
}

export function useCounts(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.counts,
    queryFn: () => api.get<CountsResponse>(`${STOCK_PATHS.counts}?page=1&pageSize=200`),
    enabled,
  });
}

export function useCount(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.count(id),
    queryFn: () => api.get<CountDetail>(STOCK_PATHS.count(id)),
  });
}

/** Active stock items found by a search (no services or kits: they hold no stock). */
export function useStockItemSearch(q: string) {
  const api = useApi();
  const params = new URLSearchParams({
    q,
    status: 'active',
    itemType: 'stock',
    page: '1',
    pageSize: '10',
  });
  return useQuery({
    queryKey: [...MD_KEYS.items, 'stock-pick', q] as QueryKey,
    queryFn: () => api.get<ItemsResponse>(`/api/v1/items?${params.toString()}`),
    enabled: q.length > 0,
  });
}
