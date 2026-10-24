/**
 * The first-run wizard, path "Restore from backup" (decision 0102, M6.2 part E): choose the copy
 * (found by the PC's native side on USB drives, in Downloads, Desktop, Documents and the local
 * backups, or typed as a full path) → the private key for an encrypted copy (typed or loaded from
 * the key file; it stays in memory and goes only to the restore program) → confirm → the restore
 * runs, step by step → the result. After a restore, this PC is enrolled as the point of sale with
 * the code the restore made, and the normal sign-in follows (the old password and phone code).
 */
import { useEffect, useState, type ChangeEvent, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  privateKeyIn,
  type RestoreCopy,
  type RestoreFailure,
  type RestoreResult,
  type RestoreStep,
} from '@artepool/shared/contracts';
import { Alert, Button, cx, Note, TextField } from '../../ui';
import authStyles from '../auth/auth.module.css';
import { useAuthController } from '../auth/context';
import { AuthFrame, Hello } from '../auth/parts';
import styles from './setup.module.css';

type Screen = 'choose' | 'key' | 'confirm' | 'running' | 'failed' | 'restored';

const STEPS: RestoreStep[] = [
  'opening',
  'restoring',
  'upgrading',
  'checking',
  'replacing',
  'enrolling',
  'backing_up',
];

/** How often the screen asks how the restore is going. */
export const POLL_MS = 1000;

type Restored = Extract<RestoreResult, { ok: true }>;
type Failed = Extract<RestoreResult, { ok: false }>;

export function RestoreFlow({
  onBack,
  onEnroll,
}: {
  onBack: () => void;
  /** After a restore: enroll this PC with the restore's code (or without one: the normal way). */
  onEnroll: (code: string | null) => void;
}) {
  const [screen, setScreen] = useState<Screen>('choose');
  const [copy, setCopy] = useState<RestoreCopy | null>(null);
  const [privateKey, setPrivateKey] = useState('');
  const [failed, setFailed] = useState<Failed | null>(null);
  const [restored, setRestored] = useState<Restored | null>(null);

  const fail = (result: Failed) => {
    setFailed(result);
    setScreen('failed');
  };

  switch (screen) {
    case 'choose':
      return (
        <ChooseCopy
          chosen={copy}
          onBack={onBack}
          onChosen={(picked) => {
            setCopy(picked);
            setScreen(picked.encrypted ? 'key' : 'confirm');
          }}
        />
      );
    case 'key':
      return (
        <KeyStep
          onBack={() => setScreen('choose')}
          onKey={(key) => {
            setPrivateKey(key);
            setScreen('confirm');
          }}
        />
      );
    case 'confirm':
      return (
        <Confirm
          copy={copy!}
          privateKey={privateKey}
          onBack={() => setScreen(copy!.encrypted ? 'key' : 'choose')}
          onStarted={() => {
            // The key has gone to the restore program; the screens forget it.
            setPrivateKey('');
            setScreen('running');
          }}
          onRefused={(reason) => fail({ ok: false, reason })}
        />
      );
    case 'running':
      return (
        <Running
          onDone={(result) => {
            if (result.ok) {
              setRestored(result);
              setScreen('restored');
            } else fail(result);
          }}
        />
      );
    case 'failed':
      return (
        <FailedScreen
          result={failed!}
          onAgain={() => setScreen(failed?.reason === 'wrong_key' ? 'key' : 'choose')}
        />
      );
    case 'restored':
      return <RestoredScreen result={restored!} onEnroll={onEnroll} />;
  }
}

function useProblem() {
  const [problem, setProblem] = useState<{ text: string; attempt: number } | null>(null);
  return {
    fail: (text: string) =>
      setProblem((previous) => ({ text, attempt: (previous?.attempt ?? 0) + 1 })),
    clear: () => setProblem(null),
    shown: problem && (
      <Alert key={problem.attempt} shake>
        {problem.text}
      </Alert>
    ),
  };
}

const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

function ChooseCopy({
  chosen,
  onBack,
  onChosen,
}: {
  chosen: RestoreCopy | null;
  onBack: () => void;
  onChosen: (copy: RestoreCopy) => void;
}) {
  const { t, i18n } = useTranslation('firstRun');
  const controller = useAuthController();
  const problem = useProblem();
  const [copies, setCopies] = useState<RestoreCopy[] | null>(null);
  const [selected, setSelected] = useState<string | null>(chosen?.path ?? null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const look = async () => {
    setBusy(true);
    try {
      const found = await controller.restore.restoreCopies();
      setCopies(found);
      setSelected((current) => current ?? found[0]?.path ?? null);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void look();
    // Once, when the screen opens; "Look again" repeats it.
  }, []);

  const useTyped = async () => {
    problem.clear();
    const [found] = await controller.restore.restoreCopies(typed.trim());
    if (!found) return problem.fail(t('restore.choose.notFound'));
    setCopies((list) => [found, ...(list ?? []).filter((c) => c.path !== found.path)]);
    setSelected(found.path);
  };

  const next = () => {
    const copy = copies?.find((c) => c.path === selected);
    if (!copy) return problem.fail(t('restore.choose.pick'));
    onChosen(copy);
  };

  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', {
      timeZone: 'Asia/Dubai',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

  return (
    <AuthFrame wide>
      <Hello title={t('restore.choose.title')} subtitle={t('restore.choose.subtitle')} />
      <div className={cx(authStyles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        {problem.shown}
        {copies && copies.length === 0 && <Alert tone="warn">{t('restore.choose.none')}</Alert>}
        {copies && copies.length > 0 && (
          <fieldset className={styles.copies}>
            <legend>{t('restore.choose.list')}</legend>
            {copies.map((copy) => (
              <label key={copy.path} className={styles.copy}>
                <input
                  type="radio"
                  name="copy"
                  value={copy.path}
                  checked={selected === copy.path}
                  onChange={() => setSelected(copy.path)}
                />
                <span className={styles.copyText}>
                  <bdi dir="ltr" className={styles.copyName}>
                    {copy.name}
                  </bdi>
                  <small>
                    {when(copy.modifiedAt)} · {t(`restore.choose.places.${copy.place}`)} ·{' '}
                    {t('restore.choose.megabytes', { size: megabytes(copy.bytes) })} ·{' '}
                    {t(copy.encrypted ? 'restore.choose.encrypted' : 'restore.choose.plain')}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <Note>{t('restore.choose.drive')}</Note>
        <Button variant="default" busy={busy} onPress={() => void look()}>
          {t('restore.choose.again')}
        </Button>
        <TextField
          label={t('restore.choose.path')}
          name="copyPath"
          value={typed}
          onChange={setTyped}
          ltr
          autoComplete="off"
          hint={t('restore.choose.pathHint')}
        />
        <Button variant="default" isDisabled={!typed.trim()} onPress={() => void useTyped()}>
          {t('restore.choose.use')}
        </Button>
        <Button variant="primary" size="lg" block onPress={next}>
          {t('restore.choose.next')}
        </Button>
        <Button variant="ghost" onPress={onBack}>
          {t('restore.choose.back')}
        </Button>
      </div>
    </AuthFrame>
  );
}

function KeyStep({ onBack, onKey }: { onBack: () => void; onKey: (key: string) => void }) {
  const { t } = useTranslation('firstRun');
  const problem = useProblem();
  const [text, setText] = useState('');

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const key = privateKeyIn(await file.text());
    if (!key) return problem.fail(t('restore.key.fileInvalid'));
    problem.clear();
    onKey(key);
  };

  const next = () => {
    const key = privateKeyIn(text);
    if (!key) return problem.fail(t('restore.key.invalid'));
    setText('');
    onKey(key);
  };

  return (
    <AuthFrame wide>
      <Hello title={t('restore.key.title')} subtitle={t('restore.key.subtitle')} />
      <div className={cx(authStyles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        {problem.shown}
        <TextField
          label={t('restore.key.label')}
          name="privateKey"
          value={text}
          onChange={setText}
          type="password"
          ltr
          autoComplete="off"
        />
        <label className={styles.file}>
          <span>{t('restore.key.file')}</span>
          <input type="file" accept=".txt,text/plain" onChange={(e) => void loadFile(e)} />
        </label>
        <Button variant="primary" size="lg" block onPress={next}>
          {t('restore.key.next')}
        </Button>
        <Button variant="ghost" onPress={onBack}>
          {t('restore.choose.back')}
        </Button>
      </div>
    </AuthFrame>
  );
}

function Confirm({
  copy,
  privateKey,
  onBack,
  onStarted,
  onRefused,
}: {
  copy: RestoreCopy;
  privateKey: string;
  onBack: () => void;
  onStarted: () => void;
  onRefused: (reason: RestoreFailure) => void;
}) {
  const { t } = useTranslation('firstRun');
  const controller = useAuthController();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const answer = await controller.restore.restoreStart({ path: copy.path, privateKey });
      if (answer.started) onStarted();
      else onRefused(answer.reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame wide>
      <Hello title={t('restore.confirm.title')} subtitle={t('restore.confirm.subtitle')} />
      <div className={cx(authStyles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        <p>{t('restore.confirm.copy', { name: copy.name })}</p>
        {!copy.encrypted && <Alert tone="warn">{t('restore.confirm.plainWarning')}</Alert>}
        <Button variant="primary" size="lg" block busy={busy} onPress={() => void start()}>
          {t('restore.confirm.start')}
        </Button>
        <Button variant="ghost" isDisabled={busy} onPress={onBack}>
          {t('restore.choose.back')}
        </Button>
      </div>
    </AuthFrame>
  );
}

function Running({ onDone }: { onDone: (result: RestoreResult) => void }) {
  const { t } = useTranslation('firstRun');
  const controller = useAuthController();
  const [step, setStep] = useState<RestoreStep | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const status = await controller.restore.restoreStatus();
      if (stopped) return;
      setStep(status.step);
      if (!status.running && status.result) onDone(status.result);
      else timer = setTimeout(() => void ask(), POLL_MS);
    };
    void ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // The restore runs once; the screen only follows it.
  }, []);

  const current = step ? STEPS.indexOf(step) : -1;
  return (
    <AuthFrame wide>
      <Hello title={t('restore.running.title')} subtitle={t('restore.running.subtitle')} />
      <ol className={cx(styles.steps, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        {STEPS.map((name, index) => (
          <li
            key={name}
            className={cx(index < current && styles.done, index === current && styles.current)}
            aria-current={index === current ? 'step' : undefined}
          >
            {t(`restore.running.steps.${name}`)}
          </li>
        ))}
      </ol>
    </AuthFrame>
  );
}

function FailedScreen({ result, onAgain }: { result: Failed; onAgain: () => void }) {
  const { t } = useTranslation('firstRun');
  return (
    <AuthFrame wide>
      <Hello title={t('restore.failed.title')} subtitle={t(`restore.failures.${result.reason}`)} />
      <div className={cx(authStyles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        {result.detail && (
          <Note>
            <bdi dir="ltr">{t('restore.failed.detail', { detail: result.detail })}</bdi>
          </Note>
        )}
        <Button variant="primary" size="lg" block onPress={onAgain}>
          {t('restore.failed.again')}
        </Button>
      </div>
    </AuthFrame>
  );
}

function RestoredScreen({
  result,
  onEnroll,
}: {
  result: Restored;
  onEnroll: (code: string | null) => void;
}) {
  const { t } = useTranslation('firstRun');
  return (
    <AuthFrame wide>
      <Hello title={t('restore.restored.title')} subtitle={t('restore.restored.subtitle')} />
      <div className={cx(authStyles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        {!result.backup.ok && <Alert tone="warn">{t('restore.restored.backupFailed')}</Alert>}
        {!result.masterKeyRestored && <Alert tone="warn">{t('restore.restored.noKey')}</Alert>}
        {result.revokedDevices > 0 && (
          <p>{t('restore.restored.devices', { count: result.revokedDevices })}</p>
        )}
        {result.devicesWithOpenShifts.length > 0 && (
          <p>
            {t('restore.restored.openShifts', { list: result.devicesWithOpenShifts.join(', ') })}
          </p>
        )}
        <p>{t('restore.restored.drive')}</p>
        <Note>{t(result.enrollment ? 'restore.restored.enroll' : 'restore.restored.noCode')}</Note>
        <Button
          variant="primary"
          size="lg"
          block
          onPress={() => onEnroll(result.enrollment?.code ?? null)}
        >
          {t('restore.restored.toEnroll')}
        </Button>
      </div>
    </AuthFrame>
  );
}
