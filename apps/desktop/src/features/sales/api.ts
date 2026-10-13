/**
 * Server calls of the sales sections (M4, decision 0045): Invoices (A4), Quotations and Receipts.
 * Every list lives under SALES_KEYS.all, so one refresh after a save updates them all; customer
 * balances and stock figures change too, so they are refreshed with it.
 */
import { useQuery, type QueryKey } from '@tanstack/react-query';
import type {
  CustomerBalance,
  CustomersResponse,
  DocumentDetail,
  DocumentsQuery,
  DocumentsResponse,
  FilePayload,
  ItemsResponse,
  PaymentDetail,
  PaymentsQuery,
  PaymentsResponse,
  QuotationDetail,
  QuotationsQuery,
  QuotationsResponse,
  SalesPaymentMethod,
  StatementResponse,
} from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { MD_KEYS } from '../masterdata/refs';

export const SALES_PATHS = {
  documents: '/api/v1/sales/documents',
  document: (id: string) => `/api/v1/sales/documents/${id}`,
  documentPdf: (id: string) => `/api/v1/sales/documents/${id}/pdf`,
  documentPrinted: (id: string) => `/api/v1/sales/documents/${id}/printed`,
  issue: (id: string) => `/api/v1/sales/documents/${id}/issue`,
  discard: (id: string) => `/api/v1/sales/documents/${id}/discard`,
  invoices: '/api/v1/sales/invoices',
  invoice: (id: string) => `/api/v1/sales/invoices/${id}`,
  notes: '/api/v1/sales/notes',
  quotations: '/api/v1/sales/quotations',
  quotation: (id: string) => `/api/v1/sales/quotations/${id}`,
  quotationAction: (id: string) => `/api/v1/sales/quotations/${id}/action`,
  quotationRevise: (id: string) => `/api/v1/sales/quotations/${id}/revise`,
  quotationConvert: (id: string) => `/api/v1/sales/quotations/${id}/convert`,
  quotationPdf: (id: string) => `/api/v1/sales/quotations/${id}/pdf`,
  payments: '/api/v1/sales/payments',
  payment: (id: string) => `/api/v1/sales/payments/${id}`,
  paymentPdf: (id: string) => `/api/v1/sales/payments/${id}/pdf`,
  reverse: (id: string) => `/api/v1/sales/payments/${id}/reverse`,
  paymentMethods: '/api/v1/sales/payment-methods',
  customerBalance: (id: string) => `/api/v1/customers/${id}/balance`,
  statement: (id: string) => `/api/v1/customers/${id}/statement`,
  statementPdf: (id: string) => `/api/v1/customers/${id}/statement/pdf`,
  openingBalance: (id: string) => `/api/v1/customers/${id}/opening-balance`,
  openingBalances: '/api/v1/customers/opening-balances',
};

export const SALES_KEYS = {
  all: ['sales'] as QueryKey,
  documents: (q: unknown) => ['sales', 'documents', q] as QueryKey,
  document: (id: string) => ['sales', 'document', id] as QueryKey,
  quotations: (q: unknown) => ['sales', 'quotations', q] as QueryKey,
  quotation: (id: string) => ['sales', 'quotation', id] as QueryKey,
  payments: (q: unknown) => ['sales', 'payments', q] as QueryKey,
  payment: (id: string) => ['sales', 'payment', id] as QueryKey,
  balance: (customerId: string) => ['sales', 'balance', customerId] as QueryKey,
  statement: (customerId: string, from: string, to: string) =>
    ['sales', 'statement', customerId, from, to] as QueryKey,
  paymentMethods: ['sales', 'payment-methods'] as QueryKey,
};

/** What every sales save refreshes: the sales lists, stock (sales move it) and customers. */
export const SALES_INVALIDATE: QueryKey[] = [
  SALES_KEYS.all,
  MD_KEYS.stock,
  MD_KEYS.items,
  MD_KEYS.customers,
];

const queryString = (q: Record<string, string | number | boolean | null | undefined>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q))
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  return params.toString();
};

export function useDocuments(q: Partial<DocumentsQuery>, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: SALES_KEYS.documents(q),
    queryFn: () =>
      api.get<DocumentsResponse>(
        `${SALES_PATHS.documents}?${queryString({ pageSize: 100, ...q })}`,
      ),
    enabled,
  });
}

export function useDocument(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: SALES_KEYS.document(id ?? ''),
    queryFn: () => api.get<DocumentDetail>(SALES_PATHS.document(id ?? '')),
    enabled: id !== null,
  });
}

export function useQuotations(q: Partial<QuotationsQuery>, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: SALES_KEYS.quotations(q),
    queryFn: () =>
      api.get<QuotationsResponse>(
        `${SALES_PATHS.quotations}?${queryString({ pageSize: 100, ...q })}`,
      ),
    enabled,
  });
}

export function useQuotation(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: SALES_KEYS.quotation(id ?? ''),
    queryFn: () => api.get<QuotationDetail>(SALES_PATHS.quotation(id ?? '')),
    enabled: id !== null,
  });
}

export function usePayments(q: Partial<PaymentsQuery>, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: SALES_KEYS.payments(q),
    queryFn: () =>
      api.get<PaymentsResponse>(`${SALES_PATHS.payments}?${queryString({ pageSize: 100, ...q })}`),
    enabled,
  });
}

export function usePayment(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: SALES_KEYS.payment(id ?? ''),
    queryFn: () => api.get<PaymentDetail>(SALES_PATHS.payment(id ?? '')),
    enabled: id !== null,
  });
}

export function useSalesPaymentMethods() {
  const api = useApi();
  return useQuery({
    queryKey: SALES_KEYS.paymentMethods,
    queryFn: async () =>
      (await api.get<{ paymentMethods: SalesPaymentMethod[] }>(SALES_PATHS.paymentMethods))
        .paymentMethods,
  });
}

export function useCustomerBalance(customerId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: SALES_KEYS.balance(customerId ?? ''),
    queryFn: () => api.get<CustomerBalance>(SALES_PATHS.customerBalance(customerId ?? '')),
    enabled: customerId !== null,
  });
}

export function useStatement(customerId: string | null, from: string, to: string) {
  const api = useApi();
  return useQuery({
    queryKey: SALES_KEYS.statement(customerId ?? '', from, to),
    queryFn: () =>
      api.get<StatementResponse>(
        `${SALES_PATHS.statement(customerId ?? '')}?${queryString({ from, to })}`,
      ),
    enabled: customerId !== null && from !== '' && to !== '',
  });
}

/** Active customers matching a search (name, phone, TRN); the first ones when nothing is typed. */
export function useCustomerSearch(q: string, enabled = q.length > 0) {
  const api = useApi();
  return useQuery({
    queryKey: [...MD_KEYS.customers, 'pick', q] as QueryKey,
    queryFn: () =>
      api.get<CustomersResponse>(
        `/api/v1/customers?${queryString({ q, status: 'active', pageSize: 20 })}`,
      ),
    enabled,
  });
}

/** Items matching a search (any words of the name, code, barcode); the first ones when empty. */
export function useSellableItemSearch(q: string, enabled = q.length > 0) {
  const api = useApi();
  return useQuery({
    queryKey: [...MD_KEYS.items, 'sell', q] as QueryKey,
    queryFn: () =>
      api.get<ItemsResponse>(`/api/v1/items?${queryString({ q, status: 'active', pageSize: 20 })}`),
    enabled,
  });
}

/** Fetches a PDF the server made (base64 JSON) for printing. */
export const fetchPdf = (api: ReturnType<typeof useApi>, path: string) =>
  api.get<FilePayload>(path);
