import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import type { AuthController, AuthState } from './controller';

const AuthContext = createContext<AuthController | null>(null);

export function AuthProvider({
  controller,
  children,
}: {
  controller: AuthController;
  children: ReactNode;
}) {
  return <AuthContext.Provider value={controller}>{children}</AuthContext.Provider>;
}

export function useAuthController(): AuthController {
  const controller = useContext(AuthContext);
  if (!controller) throw new Error('useAuthController outside <AuthProvider>');
  return controller;
}

export function useAuthState(): AuthState {
  const controller = useAuthController();
  return useSyncExternalStore(controller.subscribe, controller.getState);
}

/** Does the signed-in person have this permission? (The server checks again on every call.) */
export function useCan(): (permission: string) => boolean {
  const { permissions } = useAuthState();
  return useCallback((permission: string) => permissions.includes(permission), [permissions]);
}

/** The person's name in the current language. */
export function useDisplayName(): (person: {
  displayNameAr: string;
  displayNameEn: string;
}) => string {
  const { i18n } = useTranslation();
  return useCallback(
    (person) => (i18n.language === 'en' ? person.displayNameEn : person.displayNameAr),
    [i18n.language],
  );
}

/** A failed call → the sentence to show (the server's error code, translated). */
export function useErrorText(): (error: unknown) => string {
  const { t, i18n } = useTranslation();
  return useCallback(
    (error: unknown) => {
      if (!(error instanceof ApiError)) return t('common:errors.INTERNAL');
      if (error.code === 'SERVER_UNREACHABLE') return t('auth:server.down');
      if (error.code === 'SERVER_UNTRUSTED') return t('auth:server.untrusted');
      // A broken business rule names itself (e.g. ACCOUNT_IN_USE), with its own message.
      const rule = error.details.rule;
      if (typeof rule === 'string' && i18n.exists(`common:errors.rules.${rule}`)) {
        return t(`common:errors.rules.${rule}`, error.details);
      }
      const key = `common:errors.${error.code}`;
      return i18n.exists(key) ? t(key, error.details) : t('common:errors.INTERNAL');
    },
    [t, i18n],
  );
}

/**
 * The field a refused save is about, when the server names one: a field that failed its check
 * (`details.issues[0].path`) or a duplicate (`details.field`). Lets a form show the message under
 * that field.
 */
export function errorField(error: unknown): { field: string; code: string } | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'DUPLICATE' && typeof error.details.field === 'string') {
    return { field: error.details.field, code: 'duplicate' };
  }
  const issues = error.details.issues;
  if (error.code === 'VALIDATION_FAILED' && Array.isArray(issues)) {
    const first = issues[0] as { path?: unknown[]; code?: unknown } | undefined;
    const field = first?.path?.[0];
    if (typeof field === 'string' && typeof first?.code === 'string') {
      return { field, code: first.code };
    }
  }
  return null;
}
