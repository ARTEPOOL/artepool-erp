import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../ui';
import { LoginFrame } from './LoginFrame';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

/** The app root. The sign-in screens (T9) and the shell with Settings (T10) plug in here. */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <LoginFrame />
      </ToastProvider>
    </QueryClientProvider>
  );
}
