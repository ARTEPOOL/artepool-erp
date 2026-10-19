/**
 * This PC's kiosk lock (decisions 0082, 0089), read from the server at start and every few
 * seconds. In the Windows app the Rust layer asks the server itself and applies the answer to the
 * window (full screen, closing refused), failing closed; the screens only show the result. In a
 * browser (development) nothing is locked: the state is only shown.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useQuery } from '@tanstack/react-query';
import type { KioskStateResponse } from '@artepool/shared/contracts';
import type { ApiClient } from '../../api/client';
import { useApi } from '../../api/hooks';
import { useAuthState } from '../auth/context';

export const KIOSK_KEY = ['kiosk', 'state'] as const;
export const KIOSK_POLL_MS = 5_000;

export function readKiosk(api: ApiClient): Promise<KioskStateResponse> {
  if (isTauri()) return invoke<KioskStateResponse>('kiosk_refresh');
  return api.get<KioskStateResponse>('/api/v1/kiosk/state', { background: true });
}

/** The lock of this PC while it is a POS PC; undefined elsewhere or before the first answer. */
export function useKiosk(): KioskStateResponse | undefined {
  const api = useApi();
  const { device } = useAuthState();
  const query = useQuery({
    queryKey: KIOSK_KEY,
    queryFn: () => readKiosk(api),
    enabled: device?.kind === 'pos',
    refetchInterval: KIOSK_POLL_MS,
    refetchIntervalInBackground: true,
  });
  return device?.kind === 'pos' ? query.data : undefined;
}
