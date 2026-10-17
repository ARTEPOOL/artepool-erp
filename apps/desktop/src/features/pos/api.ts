/**
 * Server calls of the POS and the drawer shift (M5). Every POS save refreshes the POS state (the
 * shift, the drop alert), the sales lists and stock.
 */
import { useQuery, type QueryKey } from '@tanstack/react-query';
import type {
  CashAlert,
  HeldCart,
  ItemsResponse,
  PosState,
  ShiftReport,
  ShiftsQuery,
  ShiftsResponse,
} from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { MD_KEYS } from '../masterdata/refs';
import { SALES_INVALIDATE } from '../sales/api';

export const POS_PATHS = {
  state: '/api/v1/pos/state',
  sales: '/api/v1/pos/sales',
  returns: '/api/v1/pos/returns',
  receipt: (id: string) => `/api/v1/pos/receipts/${id}`,
  receiptPrinted: (id: string) => `/api/v1/pos/receipts/${id}/printed`,
  heldCarts: '/api/v1/pos/held-carts',
  heldCart: (id: string, action: 'resume' | 'discard') => `/api/v1/pos/held-carts/${id}/${action}`,
  shifts: '/api/v1/shifts',
  shift: (id: string) => `/api/v1/shifts/${id}`,
  accept: (id: string) => `/api/v1/shifts/${id}/accept-variance`,
  forceClose: (id: string) => `/api/v1/shifts/${id}/force-close`,
  alerts: '/api/v1/shifts/alerts',
  movements: '/api/v1/shifts/current/movements',
  noSale: '/api/v1/shifts/current/no-sale',
  xReport: '/api/v1/shifts/current/x-report',
  count: '/api/v1/shifts/current/count',
  recount: '/api/v1/shifts/current/recount',
  close: '/api/v1/shifts/current/close',
};

export const POS_KEYS = {
  all: ['pos'] as QueryKey,
  state: ['pos', 'state'] as QueryKey,
  held: ['pos', 'held'] as QueryKey,
  x: ['pos', 'x'] as QueryKey,
  shifts: (q: unknown) => ['pos', 'shifts', q] as QueryKey,
  shift: (id: string) => ['pos', 'shift', id] as QueryKey,
  alerts: ['pos', 'alerts'] as QueryKey,
};

export const POS_INVALIDATE: QueryKey[] = [POS_KEYS.all, ...SALES_INVALIDATE];

export function usePosState() {
  const api = useApi();
  return useQuery({ queryKey: POS_KEYS.state, queryFn: () => api.get<PosState>(POS_PATHS.state) });
}

const params = (q: Record<string, string | number | boolean | undefined>) =>
  new URLSearchParams(
    Object.entries(q).flatMap(([k, v]) => (v === undefined || v === '' ? [] : [[k, String(v)]])),
  ).toString();

/** Items for the POS: a search (name words, code, barcode) and/or a category; stock included. */
export function useCatalog(q: string, categoryId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: [...MD_KEYS.items, 'pos', q, categoryId] as QueryKey,
    queryFn: () =>
      api.get<ItemsResponse>(
        `/api/v1/items?${params({ q, categoryId: categoryId ?? undefined, status: 'active', pageSize: 48 })}`,
      ),
    placeholderData: (previous) => previous,
  });
}

export function useHeldCarts(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: POS_KEYS.held,
    queryFn: () => api.get<HeldCart[]>(POS_PATHS.heldCarts),
    enabled,
  });
}

export function useXReport(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: POS_KEYS.x,
    queryFn: () => api.get<ShiftReport>(POS_PATHS.xReport),
    enabled,
  });
}

export function useShifts(query: Partial<ShiftsQuery>) {
  const api = useApi();
  return useQuery({
    queryKey: POS_KEYS.shifts(query),
    queryFn: () =>
      api.get<ShiftsResponse>(
        `${POS_PATHS.shifts}?${params({
          cashierId: query.cashierId,
          status: query.status,
          pendingAcceptance: query.pendingAcceptance ? 'true' : undefined,
          limit: query.limit,
          offset: query.offset,
        })}`,
      ),
  });
}

export function useShiftReport(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: POS_KEYS.shift(id ?? ''),
    queryFn: () => api.get<ShiftReport>(POS_PATHS.shift(id!)),
    enabled: id !== null,
  });
}

export function useCashAlerts(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: POS_KEYS.alerts,
    queryFn: () => api.get<CashAlert[]>(POS_PATHS.alerts),
    enabled,
  });
}

/** Approvals a refused POS save asks for (the server names the rule). */
export const APPROVAL_FOR_RULE: Record<string, string> = {
  DISCOUNT_OVER_LIMIT: 'sales.discount_over_limit',
  PRICE_OVERRIDE: 'sales.price_override',
  OVERSELL_APPROVAL: 'pos.oversell',
  CREDIT_LIMIT: 'sales.credit_over_limit',
};

/** Which request field carries each approval. */
export const APPROVAL_FIELD: Record<string, string> = {
  'sales.discount_over_limit': 'approvalId',
  'sales.price_override': 'priceApprovalId',
  'pos.oversell': 'oversellApprovalId',
  'sales.credit_over_limit': 'creditApprovalId',
};
