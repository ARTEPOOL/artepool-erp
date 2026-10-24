/**
 * The first-run wizard on the server PC (decisions 0092, 0102), path "New setup": company details
 * → the owner account → phone 2-step → recovery codes → this PC enrolled as the POS → finish. It
 * opens by itself when the installer's setup token is on this PC and setup is not complete; every
 * step goes through the setup channel (the native side adds the token) and may be repeated, so
 * closing the app halfway picks up where it stopped. "Restore from backup" comes with part E.
 */
import { useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { WINDOWS_11_BUILD } from '@artepool/shared/contracts';
import type {
  CompanyProfile,
  EnrollFailure,
  SetupDeviceCodeResponse,
  SetupStatusResponse,
  SetupTwoStepConfirmResponse,
  TwoStepStartResponse,
} from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { Alert, Button, Checkbox, cx, Note, TextField } from '../../ui';
import authStyles from '../auth/auth.module.css';
import { useAuthController, useAuthState, useErrorText } from '../auth/context';
import { AuthFrame, Hello } from '../auth/parts';
import { RecoveryCodesScreen, TwoStepSetupScreen } from '../auth/TwoStepScreens';
import { readAsBase64 } from '../masterdata/files';
import { logoFileProblem } from '../settings/company/LogoCard';
import {
  checkForm,
  toForm,
  toRequest,
  type CompanyField,
  type CompanyForm,
} from '../settings/company/form';
import styles from './setup.module.css';

type Step = 'welcome' | 'company' | 'owner' | 'twoStep' | 'codes' | 'device' | 'finish' | 'done';
const NUMBERED = ['company', 'owner', 'twoStep', 'codes', 'device'] as const;

/** Where to pick up, from what the server already has. */
export function firstStep(status: SetupStatusResponse): Step {
  if (status.state === 'not_started') return 'welcome';
  if (!status.company) return 'company';
  if (!status.owner) return 'owner';
  if (!status.owner.twoStepEnabled) return 'twoStep';
  if (!status.posDevice) return 'device';
  return 'finish';
}

function StepTitle({ step }: { step: (typeof NUMBERED)[number] }) {
  const { t } = useTranslation('firstRun');
  return (
    <p className={styles.step}>
      {t('step', {
        n: NUMBERED.indexOf(step) + 1,
        total: NUMBERED.length,
        name: t(`steps.${step}`),
      })}
    </p>
  );
}

/** A failed step's message, shaking again on each new attempt. */
function useProblem() {
  const [problem, setProblem] = useState<{ text: string; attempt: number } | null>(null);
  const fail = (text: string) =>
    setProblem((previous) => ({ text, attempt: (previous?.attempt ?? 0) + 1 }));
  const shown = problem && (
    <Alert key={problem.attempt} shake>
      {problem.text}
    </Alert>
  );
  return { fail, clear: () => setProblem(null), shown };
}

export function SetupWizard({
  status,
  serverAddress,
  windowsBuild = null,
}: {
  status: SetupStatusResponse;
  serverAddress: string;
  windowsBuild?: number | null;
}) {
  const [step, setStep] = useState<Step>(() => firstStep(status));
  const [company, setCompany] = useState<CompanyProfile | null>(status.company);
  const [codes, setCodes] = useState<string[]>([]);
  const controller = useAuthController();

  switch (step) {
    case 'welcome':
      return (
        <Welcome
          windows10={windowsBuild !== null && windowsBuild < WINDOWS_11_BUILD}
          onStarted={() => setStep(company ? 'owner' : 'company')}
        />
      );
    case 'company':
      return (
        <CompanyStep
          company={company}
          onSaved={(saved) => {
            setCompany(saved);
            setStep(status.owner ? 'twoStep' : 'owner');
          }}
        />
      );
    case 'owner':
      return <OwnerStep onCreated={() => setStep('twoStep')} />;
    case 'twoStep':
      return (
        <TwoStepSetupScreen
          above={<StepTitle step="twoStep" />}
          start={() =>
            controller.setupApi.post<TwoStepStartResponse>('/api/v1/setup/two-step/start')
          }
          confirm={async (code) => {
            const done = await controller.setupApi.post<SetupTwoStepConfirmResponse>(
              '/api/v1/setup/two-step/confirm',
              { code },
            );
            setCodes(done.recoveryCodes);
            setStep('codes');
          }}
        />
      );
    case 'codes':
      return (
        <RecoveryCodesScreen
          codes={codes}
          above={<StepTitle step="codes" />}
          onSaved={() => {
            // The codes leave memory now; they are never shown again.
            setCodes([]);
            setStep('device');
          }}
        />
      );
    case 'device':
      return <DeviceStep serverAddress={serverAddress} onEnrolled={() => setStep('finish')} />;
    case 'finish':
      return <FinishStep onDone={() => setStep('done')} />;
    case 'done':
      return <Done />;
  }
}

function Welcome({ onStarted, windows10 }: { onStarted: () => void; windows10: boolean }) {
  const { t } = useTranslation('firstRun');
  const controller = useAuthController();
  const errorText = useErrorText();
  const problem = useProblem();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    problem.clear();
    try {
      await controller.setupApi.post('/api/v1/setup/start', { path: 'new' });
      onStarted();
    } catch (error) {
      problem.fail(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame wide>
      <Hello title={t('title')} subtitle={t('subtitle')} />
      <div className={cx(authStyles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        {/* Decision 0106: a warning only; setup goes on as usual. */}
        {windows10 && <Alert tone="warn">{t('windows10')}</Alert>}
        {problem.shown}
        <section className={styles.path} aria-labelledby="setup-new">
          <h2 id="setup-new">{t('paths.new.title')}</h2>
          <p>{t('paths.new.text')}</p>
          <Button variant="primary" size="lg" block busy={busy} onPress={() => void start()}>
            {t('paths.new.start')}
          </Button>
        </section>
        <section className={cx(styles.path, styles.muted)} aria-labelledby="setup-restore">
          <h2 id="setup-restore">{t('paths.restore.title')}</h2>
          <p>{t('paths.restore.text')}</p>
          <Note>{t('paths.restore.soon')}</Note>
        </section>
      </div>
    </AuthFrame>
  );
}

function CompanyStep({
  company,
  onSaved,
}: {
  company: CompanyProfile | null;
  onSaved: (company: CompanyProfile) => void;
}) {
  const { t } = useTranslation(['firstRun', 'setup', 'masterdata']);
  const controller = useAuthController();
  const errorText = useErrorText();
  const problem = useProblem();
  const [form, setForm] = useState<CompanyForm>(() => toForm(company));
  const [shown, setShown] = useState<Partial<Record<CompanyField, string>>>({});
  const [logo, setLogo] = useState<File | null>(null);
  const [logoProblem, setLogoProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const field = (name: CompanyField, extra: { ltr?: boolean; hint?: string } = {}) => (
    <TextField
      label={t(`setup:company.fields.${name}`)}
      name={name}
      value={form[name] as string}
      onChange={(value) => {
        setForm((previous) => ({ ...previous, [name]: value }));
        setShown((previous) => ({ ...previous, [name]: undefined }));
      }}
      invalid={Boolean(shown[name])}
      error={shown[name] && t(`masterdata:fields.${shown[name]}`)}
      {...extra}
    />
  );

  const pickLogo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    const why = file && logoFileProblem(file);
    setLogoProblem(why ? t(why === 'type' ? 'company.logoType' : 'company.logoSize') : null);
    setLogo(why ? null : file);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problems = checkForm(form);
    setShown(problems);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    problem.clear();
    try {
      let saved = await controller.setupApi.put<CompanyProfile>(
        '/api/v1/setup/company',
        toRequest(form, undefined),
      );
      if (logo) {
        saved = await controller.setupApi.put<CompanyProfile>('/api/v1/setup/company/logo', {
          logo: { type: logo.type, dataBase64: await readAsBase64(logo) },
        });
      }
      onSaved(saved);
    } catch (error) {
      problem.fail(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame wide>
      <StepTitle step="company" />
      <Hello title={t('company.title')} subtitle={t('company.subtitle')} />
      <form
        className={cx(authStyles.form, 'rise')}
        style={{ '--i': 2 } as CSSProperties}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {problem.shown}
        {field('legalNameAr')}
        {field('legalNameEn')}
        <Checkbox
          isSelected={form.vatRegistered}
          onChange={(vatRegistered) => setForm((previous) => ({ ...previous, vatRegistered }))}
        >
          {t('setup:company.fields.vatRegistered')}
        </Checkbox>
        {form.vatRegistered && field('trn', { ltr: true, hint: t('setup:company.trnHint') })}
        {field('addressAr')}
        {field('addressEn')}
        {field('city')}
        {field('phone', { ltr: true })}
        {field('email', { ltr: true })}
        <label className={styles.file}>
          <span>{t('company.logo')}</span>
          <input type="file" accept="image/png,image/jpeg" onChange={pickLogo} />
          <small>{t('company.logoHint')}</small>
        </label>
        {logoProblem && <Alert>{logoProblem}</Alert>}
        <Button type="submit" variant="primary" size="lg" block busy={busy}>
          {t('company.save')}
        </Button>
      </form>
    </AuthFrame>
  );
}

function OwnerStep({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation(['firstRun', 'auth']);
  const controller = useAuthController();
  const errorText = useErrorText();
  const problem = useProblem();
  const [values, setValues] = useState({
    username: '',
    displayNameAr: '',
    displayNameEn: '',
    password: '',
    again: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (name: keyof typeof values) => (value: string) =>
    setValues((previous) => ({ ...previous, [name]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (Object.values(values).some((value) => !value.trim())) {
      return problem.fail(t('owner.missing'));
    }
    if (values.password !== values.again) return problem.fail(t('owner.mismatch'));
    setBusy(true);
    problem.clear();
    try {
      await controller.setupApi.post('/api/v1/setup/owner', {
        username: values.username.trim().toLowerCase(),
        displayNameAr: values.displayNameAr.trim(),
        displayNameEn: values.displayNameEn.trim(),
        password: values.password,
      });
      onCreated();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'PASSWORD_REJECTED') {
        const found = (error.details.problems as string[] | undefined) ?? [];
        problem.fail(
          found
            .map((p) => t(`auth:change.problems.${p}`, { minLength: error.details.minLength }))
            .join(' '),
        );
      } else if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') {
        problem.fail(t('owner.invalidUsername'));
      } else {
        problem.fail(errorText(error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame wide>
      <StepTitle step="owner" />
      <Hello title={t('owner.title')} subtitle={t('owner.subtitle')} />
      <form
        className={cx(authStyles.form, 'rise')}
        style={{ '--i': 2 } as CSSProperties}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {problem.shown}
        <TextField
          label={t('owner.username')}
          name="username"
          value={values.username}
          onChange={set('username')}
          ltr
          autoComplete="off"
          hint={t('owner.usernameHint')}
        />
        <TextField
          label={t('owner.nameAr')}
          name="nameAr"
          value={values.displayNameAr}
          onChange={set('displayNameAr')}
        />
        <TextField
          label={t('owner.nameEn')}
          name="nameEn"
          value={values.displayNameEn}
          onChange={set('displayNameEn')}
          ltr
        />
        <TextField
          label={t('owner.password')}
          name="password"
          type="password"
          value={values.password}
          onChange={set('password')}
          autoComplete="new-password"
          hint={t('owner.passwordHint')}
        />
        <TextField
          label={t('owner.again')}
          name="again"
          type="password"
          value={values.again}
          onChange={set('again')}
          autoComplete="new-password"
        />
        <Button type="submit" variant="primary" size="lg" block busy={busy}>
          {t('owner.save')}
        </Button>
      </form>
    </AuthFrame>
  );
}

function DeviceStep({
  serverAddress,
  onEnrolled,
}: {
  serverAddress: string;
  onEnrolled: () => void;
}) {
  const { t } = useTranslation(['firstRun', 'auth']);
  const controller = useAuthController();
  const { suggestedCode } = useAuthState();
  const errorText = useErrorText();
  const problem = useProblem();
  const [name, setName] = useState(() => t('device.nameDefault'));
  const [code, setCode] = useState(suggestedCode);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return problem.fail(t('device.missing'));
    setBusy(true);
    problem.clear();
    try {
      const made = await controller.setupApi.post<SetupDeviceCodeResponse>(
        '/api/v1/setup/device-code',
      );
      const outcome = await controller.enrollForSetup({
        serverAddress,
        code: made.code,
        deviceCode: (code.trim() || suggestedCode).toUpperCase(),
        deviceName: name.trim(),
        deviceKind: 'pos',
      });
      if (outcome.ok) onEnrolled();
      else problem.fail(t(`auth:enroll.failures.${outcome.reason satisfies EnrollFailure}`));
    } catch (error) {
      problem.fail(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame wide>
      <StepTitle step="device" />
      <Hello title={t('device.title')} subtitle={t('device.subtitle')} />
      <form
        className={cx(authStyles.form, 'rise')}
        style={{ '--i': 2 } as CSSProperties}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {problem.shown}
        <TextField label={t('device.name')} name="deviceName" value={name} onChange={setName} />
        <TextField
          label={t('device.code')}
          name="deviceCode"
          value={code}
          onChange={setCode}
          ltr
          autoComplete="off"
          hint={t('device.codeHint')}
        />
        <Button type="submit" variant="primary" size="lg" block busy={busy}>
          {t('device.enroll')}
        </Button>
      </form>
    </AuthFrame>
  );
}

function FinishStep({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('firstRun');
  const controller = useAuthController();
  const errorText = useErrorText();
  const problem = useProblem();
  const [busy, setBusy] = useState(false);
  const finish = async () => {
    setBusy(true);
    problem.clear();
    try {
      await controller.setupApi.post('/api/v1/setup/complete');
      onDone();
    } catch (error) {
      problem.fail(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthFrame wide>
      <Hello title={t('finish.title')} subtitle={t('finish.subtitle')} />
      <div className={cx(authStyles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        {problem.shown}
        <Button variant="primary" size="lg" block busy={busy} onPress={() => void finish()}>
          {t('finish.button')}
        </Button>
      </div>
    </AuthFrame>
  );
}

function Done() {
  const { t } = useTranslation('firstRun');
  const controller = useAuthController();
  return (
    <AuthFrame wide>
      <Hello title={t('done.title')} subtitle={t('done.subtitle')} />
      <div className={cx(authStyles.form, 'rise')} style={{ '--i': 2 } as CSSProperties}>
        <Button variant="primary" size="lg" block onPress={() => void controller.setupFinished()}>
          {t('done.button')}
        </Button>
      </div>
    </AuthFrame>
  );
}
