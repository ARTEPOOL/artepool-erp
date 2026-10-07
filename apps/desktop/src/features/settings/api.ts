/**
 * Settings data: lists are read with TanStack Query; saves go through `useSave`, which sends one
 * idempotency key per operation. If the answer is lost and the same save is tried again, the
 * server recognises it and does not do it twice (architecture §5.3).
 */
import { useRef } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiError, newOperationKey, type ApiClient } from '../../api/client';
import { useAuthController } from '../auth/context';

export const KEYS = {
  users: ['settings', 'users'] as QueryKey,
  roles: ['settings', 'roles'] as QueryKey,
  devices: ['settings', 'devices'] as QueryKey,
  audit: ['settings', 'audit'] as QueryKey,
  chain: ['settings', 'audit-chain'] as QueryKey,
};

export function useApi(): ApiClient {
  return useAuthController().api;
}

export function useSave<Input, Result>(
  send: (api: ApiClient, input: Input, idempotencyKey: string) => Promise<Result>,
  options: { invalidate?: QueryKey[]; onSuccess?: (result: Result, input: Input) => void } = {},
) {
  const api = useApi();
  const queryClient = useQueryClient();
  // Kept only while retrying the same input after a connection problem.
  const pending = useRef<{ key: string; input: string } | null>(null);
  return useMutation<Result, unknown, Input>({
    mutationFn: (input) => {
      const text = JSON.stringify(input);
      if (pending.current?.input !== text)
        pending.current = { key: newOperationKey(), input: text };
      return send(api, input, pending.current.key);
    },
    onSuccess: async (result, input) => {
      pending.current = null;
      await Promise.all(
        (options.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      options.onSuccess?.(result, input);
    },
    onError: (error) => {
      if (!(error instanceof ApiError && error.isConnection)) pending.current = null;
    },
  });
}
