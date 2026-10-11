/** The lists that have no shared reader yet (the others are in `masterdata/refs`). */
import { useQuery } from '@tanstack/react-query';
import type {
  PaymentMethodItem,
  ReasonCodeItem,
  TechnicianItem,
  WarehouseItem,
} from '@artepool/shared/contracts';
import { useApi } from '../../../api/hooks';
import { MD_KEYS } from '../../masterdata/refs';

export function useTechnicians(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.technicians,
    queryFn: async () =>
      (await api.get<{ technicians: TechnicianItem[] }>('/api/v1/technicians')).technicians,
    enabled,
  });
}

export function usePaymentMethods() {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.paymentMethods,
    queryFn: async () =>
      (await api.get<{ paymentMethods: PaymentMethodItem[] }>('/api/v1/payment-methods'))
        .paymentMethods,
  });
}

export function useWarehouses() {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.warehouses,
    queryFn: async () =>
      (await api.get<{ warehouses: WarehouseItem[] }>('/api/v1/warehouses')).warehouses,
  });
}

export function useReasonCodes() {
  const api = useApi();
  return useQuery({
    queryKey: MD_KEYS.reasonCodes,
    queryFn: async () =>
      (await api.get<{ reasonCodes: ReasonCodeItem[] }>('/api/v1/reason-codes')).reasonCodes,
  });
}
