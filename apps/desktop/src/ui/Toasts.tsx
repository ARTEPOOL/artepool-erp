import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import styles from './Toasts.module.css';

interface Toast {
  id: number;
  message: string;
  tone: 'ok' | 'warn';
}

const ToastContext = createContext<(message: string, tone?: 'ok' | 'warn') => void>(
  () => undefined,
);

/** Short confirmations at the bottom of the screen (the design's toasts), read out politely. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: 'ok' | 'warn' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 3200);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div role="status" aria-live="polite" className={styles.region}>
        {toasts.map((t) => (
          <div key={t.id} className={styles.toast}>
            {t.tone === 'ok' ? <Check aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
