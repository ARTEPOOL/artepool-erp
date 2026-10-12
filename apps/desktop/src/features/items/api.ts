/**
 * Server calls of the Items & stock screen (design 07). Lists are read with TanStack Query under
 * `MD_KEYS.items`, so one refresh after a save updates the list, the tiles and the open item.
 * The server checks every permission again.
 */
import { useInfiniteQuery, useQuery, type QueryKey } from '@tanstack/react-query';
import type {
  ItemDetail,
  ItemsResponse,
  ItemStockResponse,
  NextItemCodeResponse,
} from '@artepool/shared/contracts';
import type { ApiClient } from '../../api/client';
import { useApi } from '../../api/hooks';
import { MD_KEYS } from '../masterdata/refs';

export const PAGE_SIZE = 50;

export const itemPath = (id: string, action = '') => `/api/v1/items/${id}${action}`;

/**
 * What the list shows: a search, active or deactivated items, a top-level category, and only the
 * stock items at or below their reorder level.
 */
export interface ItemsFilter {
  q: string;
  status: 'active' | 'inactive';
  categoryId: string | null;
  toReorder?: boolean;
}

function listUrl(filter: ItemsFilter, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  if (filter.q) params.set('q', filter.q);
  params.set('status', filter.status);
  if (filter.categoryId) params.set('categoryId', filter.categoryId);
  if (filter.toReorder) params.set('toReorder', 'true');
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return `/api/v1/items?${params.toString()}`;
}

/** The items list, a page at a time ("Show more" asks for the next page). */
export function useItemList(filter: ItemsFilter) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: [...MD_KEYS.items, 'list', filter] as QueryKey,
    queryFn: ({ pageParam }) => api.get<ItemsResponse>(listUrl(filter, pageParam, PAGE_SIZE)),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => {
      const shown = pages.reduce((n, p) => n + p.items.length, 0);
      return shown < last.total && last.items.length > 0 ? pages.length + 1 : undefined;
    },
  });
}

/** One item with its barcodes, kit components, price and row version. */
export function useItem(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.item(id ?? ''),
    queryFn: () => api.get<ItemDetail>(itemPath(id ?? '')),
    enabled: id !== null,
  });
}

/** Active items found by a search, for choosing kit components. */
export function useItemSearch(q: string) {
  const api = useApi();
  return useQuery({
    queryKey: [...MD_KEYS.items, 'pick', q] as QueryKey,
    queryFn: () =>
      api.get<ItemsResponse>(listUrl({ q, status: 'active', categoryId: null }, 1, 10)),
    enabled: q.length > 0,
  });
}

/** The next free code in a category (e.g. CHEM-0013): suggested, editable until the first save. */
export async function suggestCode(api: ApiClient, categoryId: string): Promise<string> {
  const answer = await api.get<NextItemCodeResponse>(
    `/api/v1/items/next-code?categoryId=${encodeURIComponent(categoryId)}`,
  );
  return answer.code;
}

/**
 * One item's stock card (needs `stock.view`): balances per warehouse and status, and its
 * movements newest first, `pageSize` at a time. Values come only with `stock.view_cost`.
 */
export function useItemStock(id: string, pageSize: number, enabled: boolean) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: [...MD_KEYS.itemStock(id), pageSize] as QueryKey,
    queryFn: ({ pageParam }) =>
      api.get<ItemStockResponse>(
        `${itemPath(id, '/stock')}?page=${pageParam}&pageSize=${pageSize}`,
      ),
    initialPageParam: 1,
    enabled,
    getNextPageParam: (last, pages) => {
      const shown = pages.reduce((n, p) => n + p.movements.length, 0);
      return shown < last.totalMovements && last.movements.length > 0
        ? pages.length + 1
        : undefined;
    },
  });
}
