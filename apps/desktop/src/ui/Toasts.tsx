import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  // The timers that hide each toast; stopped when the provider goes away, so none fires afterwards.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  const push = useCallback((message: string, tone: 'ok' | 'warn' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts((list) => list.filter((t) => t.id !== id));
    }, 3200);
    timers.current.add(timer);
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
