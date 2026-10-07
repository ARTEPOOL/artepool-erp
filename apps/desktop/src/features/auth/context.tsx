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
      const key = `common:errors.${error.code}`;
      return i18n.exists(key) ? t(key, error.details) : t('common:errors.INTERNAL');
    },
    [t, i18n],
  );
}
