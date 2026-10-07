import { Lock, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthController, useAuthState, useDisplayName } from '../features/auth/context';
import { AuthFrame, Hello } from '../features/auth/parts';
import { Button, iconClass } from '../ui';

/** Until the app shell arrives (T10): who is signed in, with lock and sign out. */
export function Home() {
  const { t } = useTranslation('auth');
  const controller = useAuthController();
  const { user } = useAuthState();
  const nameOf = useDisplayName();
  return (
    <AuthFrame>
      <Hello
        title={t('home.welcome', { name: user ? nameOf(user) : '' })}
        subtitle={t('home.next')}
      />
      <Button onPress={() => void controller.lock()}>
        <Lock className={iconClass.sm} aria-hidden="true" />
        {t('home.lock')}
      </Button>
      <Button variant="ghost" onPress={() => void controller.signOut()}>
        <LogOut className={iconClass.sm} aria-hidden="true" />
        {t('home.signOut')}
      </Button>
    </AuthFrame>
  );
}
