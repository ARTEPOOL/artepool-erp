import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { defaultBridge, type Bridge } from '../api/bridge';
import { AuthGate } from '../features/auth/AuthGate';
import { AuthProvider, useAuthState } from '../features/auth/context';
import { AuthController } from '../features/auth/controller';
import { ToastProvider } from '../ui';
import { createAppRouter } from './router';

/**
 * The signed-in app. The place in the app survives the lock screen; a different person always
 * starts on the dashboard, and nothing loaded for the previous person stays in memory.
 */
function Root() {
  const queryClient = useQueryClient();
  const { user } = useAuthState();
  const userId = user?.id ?? null;
  const router = useMemo(() => createAppRouter(), [userId]);
  useEffect(() => () => queryClient.clear(), [queryClient, userId]);
  return (
    <AuthGate>
      <RouterProvider router={router} />
    </AuthGate>
  );
}

/** The app root: the sign-in flow first, then the app shell with Settings. */
export function App({ bridge }: { bridge?: Bridge }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
  const [controller] = useState(() => new AuthController(bridge ?? defaultBridge()));
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider controller={controller}>
          <Root />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
