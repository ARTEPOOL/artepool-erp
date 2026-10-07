import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'artepool.theme';
const listeners = new Set<() => void>();

/** `light` / `dark` chosen on this PC, or `system` (follow Windows). */
export type ThemeChoice = 'light' | 'dark' | 'system';

function saved(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Applies the theme the design's way: `data-theme` on <html>, or nothing to follow the system. */
export function applyTheme(choice: ThemeChoice = saved()): void {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  listeners.forEach((listener) => listener());
}

function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export function isDark(): boolean {
  const chosen = document.documentElement.dataset.theme;
  return chosen ? chosen === 'dark' : systemDark();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const media =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  media?.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    media?.removeEventListener('change', listener);
  };
}

/** [is it dark now, switch between light and dark] — like the design's sun/moon button. */
export function useTheme(): [boolean, () => void] {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  const toggle = useCallback(() => {
    const next: ThemeChoice = isDark() ? 'light' : 'dark';
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not remembered, still applied.
    }
    applyTheme(next);
  }, []);
  return [dark, toggle];
}
