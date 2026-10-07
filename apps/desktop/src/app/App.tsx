import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { defaultBridge, type Bridge } from '../api/bridge';
import { AuthGate } from '../features/auth/AuthGate';
import { AuthProvider } from '../features/auth/context';
import { AuthController } from '../features/auth/controller';
import { ToastProvider } from '../ui';
import { Home } from './Home';

/** The app root: the sign-in flow first, then the app (the shell with Settings arrives in T10). */
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
          <AuthGate>
            <Home />
          </AuthGate>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
