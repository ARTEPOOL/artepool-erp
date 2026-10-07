import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Note } from '../../ui';
import { ChangeCredentialScreen } from './ChangeCredentialScreen';
import { useAuthController, useAuthState } from './context';
import { EnrollScreen } from './EnrollScreen';
import { LockScreen } from './LockScreen';
import { AuthFrame, Hello } from './parts';
import { SecondFactorScreen } from './SecondFactorScreen';
import { SignInScreen } from './SignInScreen';
import { RecoveryCodesScreen, TwoStepSetupScreen } from './TwoStepScreens';

/**
 * Shows the screen the sign-in flow is at, and the app (`children`) only once the session is
 * complete. Starts the flow and the idle lock when it mounts.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const controller = useAuthController();
  const { phase } = useAuthState();

  useEffect(() => {
    void controller.start();
    return controller.watchIdle(window);
  }, [controller]);

  switch (phase.name) {
    case 'starting':
      return (
        <AuthFrame>
          <Note>{t('auth:starting')}</Note>
        </AuthFrame>
      );
    case 'enroll':
      return <EnrollScreen notice={phase.notice} />;
    case 'outdated':
      return (
        <AuthFrame>
          <Hello title={t('auth:outdated.title')} />
          <Alert tone="warn">
            {t('common:errors.CLIENT_OUTDATED', { minVersion: phase.minVersion })}
          </Alert>
        </AuthFrame>
      );
    case 'signIn':
      return <SignInScreen />;
    case 'secondFactor':
      return <SecondFactorScreen />;
    case 'changeCredential':
      return <ChangeCredentialScreen credential={phase.credential} />;
    case 'twoStepSetup':
      return <TwoStepSetupScreen />;
    case 'recoveryCodes':
      return <RecoveryCodesScreen codes={phase.codes} />;
    case 'locked':
      return <LockScreen />;
    case 'app':
      return children;
  }
}
