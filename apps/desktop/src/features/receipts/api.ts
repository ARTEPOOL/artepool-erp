/**
 * Server reads of the Receipts section that the shared sales hooks do not cover: a customer's
 * opening balance (decision 0051) and the open debts a payment can settle (decision 0052).
 */
import { useQuery, type QueryKey } from '@tanstack/react-query';
import type { OpeningBalanceItem } from '@artepool/shared/contracts';
import { useApi } from '../../api/hooks';
import { SALES_PATHS, useDocuments } from '../sales/api';
import { debtsFrom } from './allocation';

/** Under SALES_KEYS.all, so every sales save (SALES_INVALIDATE) refreshes it too. */
export const openingKey = (customerId: string) =>
  ['sales', 'opening-balance', customerId] as QueryKey;

export function useOpeningBalance(customerId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: openingKey(customerId ?? ''),
    queryFn: async () =>
      (
        await api.get<{ openingBalance: OpeningBalanceItem | null }>(
          SALES_PATHS.openingBalance(customerId ?? ''),
        )
      ).openingBalance,
    enabled: enabled && customerId !== null,
  });
}

/**
 * What the customer still owes, oldest first, as the server settles it (0052): the opening
 * balance, then issued invoices and debit notes by issue date.
 */
export function useOpenDebts(customerId: string | null) {
  const documents = useDocuments(
    { customerId: customerId ?? undefined, status: 'issued', settlement: 'unpaid', pageSize: 200 },
    customerId !== null,
  );
  const opening = useOpeningBalance(customerId);
  const ready = documents.isSuccess && (opening.isSuccess || opening.isError);
  return {
    debts: ready ? debtsFrom(documents.data.documents, opening.data ?? null) : [],
    isLoading: customerId !== null && !ready && !documents.isError,
    error: documents.error,
  };
}
