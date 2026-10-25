/**
 * "ARTÉPOOL – Emergency tool" (decision 0107): the window the owner opens from the Start menu of
 * the server PC, through Windows' administrator prompt. Five actions, each the console's own
 * program run by the native side: the owner's password, the owner's phone code, an enrollment
 * code, a check of the system, and the logs folder. Nobody signs in here; a temporary password is
 * shown once and forgotten when the person presses "Done".
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle } from 'lucide-react';
import type {
  EmergencyAnswer,
  EmergencyCheck,
  EmergencyDeviceCode,
  EmergencyInfo,
  PasswordResetResult,
  ServiceState,
  TwoStepResetResult,
} from '@artepool/shared/contracts';
import { LoginFrame } from '../../app/LoginFrame';
import { formatTime } from '../../lib/format';
import { Alert, Button, Checkbox, Chip, iconClass, Note, TextField } from '../../ui';
import { Hello } from '../auth/parts';
import type { EmergencyBridge } from './bridge';
import styles from './emergency.module.css';

type View = 'menu' | 'password' | 'twoStep' | 'code' | 'check';
type Failure = Extract<EmergencyAnswer<unknown>, { ok: false }>;

export function EmergencyTool({ bridge }: { bridge: EmergencyBridge }) {
  const { t } = useTranslation('emergency');
  const [info, setInfo] = useState<EmergencyInfo | null>(null);
  const [view, setView] = useState<View>('menu');
  const [logsFailed, setLogsFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void bridge.info().then((found) => live && setInfo(found));
    return () => {
      live = false;
    };
  }, [bridge]);

  const menu = () => setView('menu');
  let body: ReactNode;
  if (!info) {
    body = <Hello title={t('loading')} />;
  } else if (!info.serverPc) {
    body = (
      <>
        <Hello title={t('notServer.title')} subtitle={t('notServer.body')} />
        <Note>{t('notServer.close')}</Note>
      </>
    );
  } else if (view === 'password') {
    body = <PasswordReset bridge={bridge} onBack={menu} />;
  } else if (view === 'twoStep') {
    body = <TwoStepReset bridge={bridge} onBack={menu} />;
  } else if (view === 'code') {
    body = <DeviceCode bridge={bridge} onBack={menu} />;
  } else if (view === 'check') {
    body = <SystemCheck bridge={bridge} onBack={menu} />;
  } else {
    const openLogs = async () => setLogsFailed(!(await bridge.openLogs()));
    body = (
      <>
        <Hello title={t('menu.title')} subtitle={t('menu.subtitle')} />
        <div className={styles.actions}>
          <Action name="password" onPress={() => setView('password')} />
          <Action name="twoStep" onPress={() => setView('twoStep')} />
          <Action name="code" onPress={() => setView('code')} />
          <Action name="check" onPress={() => setView('check')} />
          <Action name="logs" onPress={() => void openLogs()} />
        </div>
        {logsFailed && <Alert>{t('menu.logs.failed')}</Alert>}
      </>
    );
  }
  return (
    <LoginFrame device={t('frame')}>
      <div className={styles.box}>{body}</div>
    </LoginFrame>
  );
}

function Action({
  name,
  onPress,
}: {
  name: 'password' | 'twoStep' | 'code' | 'check' | 'logs';
  onPress: () => void;
}) {
  const { t } = useTranslation('emergency');
  return (
    <section className={styles.action}>
      <div className={styles.actionText}>
        <h2>{t(`menu.${name}.title`)}</h2>
        <p>{t(`menu.${name}.body`)}</p>
      </div>
      <Button onPress={onPress}>{t(`menu.${name}.open`)}</Button>
    </section>
  );
}

function FailureAlert({ failure }: { failure: Failure | null }) {
  const { t } = useTranslation('emergency');
  if (!failure) return null;
  return (
    <Alert>
      {t(`errors.${failure.reason}`)}
      {failure.detail && (
        <>
          <br />
          <small>
            <bdi>{t('errors.detail', { detail: failure.detail })}</bdi>
          </small>
        </>
      )}
    </Alert>
  );
}

/** The written reason the console asks for: at least 3 characters. */
const reasonOk = (reason: string) => reason.trim().length >= 3;

function ReasonField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation('emergency');
  return (
    <TextField
      label={t('reason.label')}
      hint={t('reason.hint')}
      value={value}
      onChange={onChange}
      maxLength={500}
      multiline
      isRequired
    />
  );
}

function PasswordReset({ bridge, onBack }: { bridge: EmergencyBridge; onBack: () => void }) {
  const { t } = useTranslation('emergency');
  const [reason, setReason] = useState('');
  const [phoneLost, setPhoneLost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<PasswordResetResult | null>(null);

  if (done) {
    return (
      <>
        <Hello
          title={t('password.doneTitle')}
          subtitle={t('password.doneFor', { username: done.username })}
        />
        <div className={styles.secret}>
          <span>{t('password.temporary')}</span>
          <output aria-label={t('password.temporary')}>{done.temporaryPassword}</output>
        </div>
        <Note>
          {t('password.next')}{' '}
          {done.twoStepCleared ? t('password.nextTwoStepCleared') : t('password.nextTwoStepKept')}
        </Note>
        <Button variant="primary" onPress={onBack}>
          {t('done')}
        </Button>
      </>
    );
  }

  const submit = async () => {
    if (!reasonOk(reason)) {
      setFailure({ ok: false, reason: 'reason_required' });
      return;
    }
    setBusy(true);
    const answer = await bridge.run<PasswordResetResult>({
      action: 'reset-password',
      input: { reason: reason.trim(), phoneLost },
    });
    setBusy(false);
    if (answer.ok) setDone(answer.result);
    else setFailure(answer);
  };
  return (
    <>
      <Hello title={t('password.title')} subtitle={t('password.subtitle')} />
      <div className={styles.form}>
        <ReasonField value={reason} onChange={setReason} />
        <Checkbox isSelected={phoneLost} onChange={setPhoneLost}>
          {t('password.phoneLost')}
        </Checkbox>
        <Alert tone="warn">{t('password.warning')}</Alert>
        <FailureAlert failure={failure} />
        <div className={styles.buttons}>
          <Button variant="danger" busy={busy} onPress={() => void submit()}>
            {t('password.submit')}
          </Button>
          <Button variant="ghost" onPress={onBack}>
            {t('back')}
          </Button>
        </div>
      </div>
    </>
  );
}

function TwoStepReset({ bridge, onBack }: { bridge: EmergencyBridge; onBack: () => void }) {
  const { t } = useTranslation('emergency');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<TwoStepResetResult | null>(null);

  if (done) {
    return (
      <>
        <Hello
          title={t('twoStep.doneTitle')}
          subtitle={t('twoStep.doneFor', { username: done.username })}
        />
        <Button variant="primary" onPress={onBack}>
          {t('done')}
        </Button>
      </>
    );
  }

  const submit = async () => {
    if (!reasonOk(reason)) {
      setFailure({ ok: false, reason: 'reason_required' });
      return;
    }
    setBusy(true);
    const answer = await bridge.run<TwoStepResetResult>({
      action: 'reset-2fa',
      input: { reason: reason.trim() },
    });
    setBusy(false);
    if (answer.ok) setDone(answer.result);
    else setFailure(answer);
  };
  return (
    <>
      <Hello title={t('twoStep.title')} subtitle={t('twoStep.subtitle')} />
      <div className={styles.form}>
        <ReasonField value={reason} onChange={setReason} />
        <Alert tone="warn">{t('twoStep.warning')}</Alert>
        <FailureAlert failure={failure} />
        <div className={styles.buttons}>
          <Button variant="danger" busy={busy} onPress={() => void submit()}>
            {t('twoStep.submit')}
          </Button>
          <Button variant="ghost" onPress={onBack}>
            {t('back')}
          </Button>
        </div>
      </div>
    </>
  );
}

function DeviceCode({ bridge, onBack }: { bridge: EmergencyBridge; onBack: () => void }) {
  const { t } = useTranslation('emergency');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [code, setCode] = useState<EmergencyDeviceCode | null>(null);

  const make = async () => {
    setBusy(true);
    setFailure(null);
    const answer = await bridge.run<EmergencyDeviceCode>({ action: 'device-code', input: {} });
    setBusy(false);
    if (answer.ok) setCode(answer.result);
    else setFailure(answer);
  };
  return (
    <>
      <Hello title={t('code.title')} subtitle={t('code.subtitle')} />
      {code && (
        <>
          <div className={styles.secret}>
            <span>{t('code.label')}</span>
            <output aria-label={t('code.label')}>{code.code}</output>
          </div>
          <Note>{t('code.until', { time: formatTime(code.expiresAt) })}</Note>
        </>
      )}
      <FailureAlert failure={failure} />
      <div className={styles.buttons}>
        <Button variant={code ? 'default' : 'primary'} busy={busy} onPress={() => void make()}>
          {t('code.submit')}
        </Button>
        <Button variant="ghost" onPress={onBack}>
          {t('back')}
        </Button>
      </div>
    </>
  );
}

function Good({ ok, children }: { ok: boolean; children: ReactNode }) {
  return ok ? (
    <Chip tone="ok" icon={<CheckCircle2 className={iconClass.md} aria-hidden="true" />}>
      {children}
    </Chip>
  ) : (
    <Chip tone="danger" icon={<XCircle className={iconClass.md} aria-hidden="true" />}>
      {children}
    </Chip>
  );
}

function SystemCheck({ bridge, onBack }: { bridge: EmergencyBridge; onBack: () => void }) {
  const { t } = useTranslation('emergency');
  const [answer, setAnswer] = useState<EmergencyAnswer<EmergencyCheck> | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setAnswer(null);
    void bridge.check().then((found) => live && setAnswer(found));
    return () => {
      live = false;
    };
  }, [bridge, round]);

  let body: ReactNode = <Note>{t('check.checking')}</Note>;
  if (answer && !answer.ok) body = <FailureAlert failure={answer} />;
  if (answer?.ok) {
    const { services, secrets, database } = answer.result;
    const status = database.ok ? database.result : null;
    const service = (state: ServiceState) => (
      <Good ok={state === 'running'}>{t(`check.state.${state}`)}</Good>
    );
    const allGood =
      Object.values(services).every((s) => s === 'running') &&
      secrets &&
      status !== null &&
      status.setupComplete &&
      status.owner !== null;
    body = (
      <>
        <dl className={styles.checks}>
          {(['database', 'server', 'backup'] as const).map((key) => (
            <div key={key}>
              <dt>{t(`check.services.${key}`)}</dt>
              <dd>{service(services[key])}</dd>
            </div>
          ))}
          <div>
            <dt>{t('check.secrets')}</dt>
            <dd>
              <Good ok={secrets}>{secrets ? t('check.secretsOk') : t('check.secretsBad')}</Good>
            </dd>
          </div>
          <div>
            <dt>{t('check.database')}</dt>
            <dd>
              <Good ok={status !== null}>
                {status ? t('check.databaseOk') : t('check.databaseBad')}
              </Good>
            </dd>
          </div>
          {status && (
            <>
              <div>
                <dt>{t('check.setup')}</dt>
                <dd>
                  <Good ok={status.setupComplete}>
                    {status.setupComplete ? t('check.setupDone') : t('check.setupNotDone')}
                  </Good>
                </dd>
              </div>
              <div>
                <dt>{t('check.owner')}</dt>
                <dd>
                  <Good ok={status.owner !== null}>
                    {status.owner ? (
                      <bdi>
                        {t(
                          status.owner.twoStep ? 'check.ownerTwoStepOn' : 'check.ownerTwoStepOff',
                          { username: status.owner.username },
                        )}
                      </bdi>
                    ) : (
                      t('check.ownerNone')
                    )}
                  </Good>
                </dd>
              </div>
            </>
          )}
        </dl>
        {allGood ? (
          <Note>{t('check.allGood')}</Note>
        ) : (
          <Alert tone="warn">{t('check.notAllGood')}</Alert>
        )}
      </>
    );
  }
  return (
    <>
      <Hello title={t('check.title')} />
      {body}
      <div className={styles.buttons}>
        <Button isDisabled={answer === null} onPress={() => setRound((n) => n + 1)}>
          {t('check.again')}
        </Button>
        <Button variant="ghost" onPress={onBack}>
          {t('back')}
        </Button>
      </div>
    </>
  );
}
