/**
 * The sign-in flow (decisions 0021–0026), independent of the screens so it can be tested alone.
 *
 * Which screen shows is decided here: enroll this PC → sign in (password, or PIN on POS PCs)
 * → owner 2-step code (unless this PC is trusted, decision 0027) → required steps (own
 * password/PIN, 2-step setup) → the app; and back to the lock screen or sign-in when the
 * session locks or ends. "Forgot password" (decision 0028) leads from sign-in straight into the
 * app. The server enforces every rule; this only follows its answers.
 */
import type {
  LocalDevice,
  MeResponse,
  PinUsersResponse,
  RecoverPasswordRequest,
  RecoverPasswordResponse,
  SecondFactorRequest,
  SessionView,
  SetupInfo,
  SetupRequest,
  SetupStatusResponse,
  SignInResponse,
  ThisDeviceResponse,
  TwoStepConfirmResponse,
  TwoStepStartResponse,
  UserView,
} from '@artepool/shared/contracts';
import type { Bridge } from '../../api/bridge';
import { ApiClient, ApiError } from '../../api/client';

export type SignInNotice = 'expired' | 'signedOut' | null;

export type Phase =
  | { name: 'starting' }
  /** The first-run wizard on the server PC (decision 0102). */
  | {
      name: 'setup';
      status: SetupStatusResponse;
      serverAddress: string;
      windowsBuild: number | null;
    }
  | { name: 'enroll'; notice: 'revoked' | 'expired' | null }
  | { name: 'outdated'; minVersion: string }
  | { name: 'signIn'; notice: SignInNotice }
  | { name: 'recoverPassword' }
  | { name: 'passwordRecovered'; codesLeft: number }
  | { name: 'secondFactor' }
  | { name: 'changeCredential'; credential: 'password' | 'pin' }
  | { name: 'twoStepSetup' }
  | { name: 'recoveryCodes'; codes: string[] }
  | { name: 'locked' }
  | { name: 'app' };

export type ServerState = 'unknown' | 'ok' | 'down' | 'untrusted';

export interface ThisDevice {
  code: string;
  name: string;
  kind: string;
}

export interface AuthState {
  phase: Phase;
  server: ServerState;
  /** This PC as enrolled (null before enrollment). */
  device: ThisDevice | null;
  /** The computer name, suggested as the device code when enrolling. */
  suggestedCode: string;
  session: SessionView | null;
  user: UserView | null;
  permissions: string[];
  /** While the 2-step code is asked: days "Trust this PC" would last here, or null if not offered. */
  trustDays: number | null;
  /** The password was reset on the server PC (decision 0029): when, and the reason given. */
  serverReset: { at: string; reason: string } | null;
}

const INITIAL: AuthState = {
  phase: { name: 'starting' },
  server: 'unknown',
  device: null,
  suggestedCode: '',
  session: null,
  user: null,
  permissions: [],
  trustDays: null,
  serverReset: null,
};

/** While the person is active, tell the server at most this often (it locks idle sessions). */
const HEARTBEAT_MS = 60_000;
const IDLE_CHECK_MS = 5_000;
/** The just-typed temporary password/PIN is kept for the "choose your own" step, no longer. */
const PENDING_SECRET_MS = 10 * 60_000;

const AUTH = '/api/v1/auth';

export class AuthController {
  readonly api: ApiClient;
  /** The first-run wizard's channel: setup steps only, the token added by the native side. */
  readonly setupApi: ApiClient;
  private state: AuthState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private pendingSecret: { value: string; until: number } | null = null;
  private lastActivity = Date.now();
  private lastHeartbeat = 0;

  constructor(private readonly bridge: Bridge) {
    this.api = new ApiClient(bridge);
    this.setupApi = new ApiClient({
      request: (request) => bridge.setupRequest(request as SetupRequest),
    });
    this.api.onError((error) => this.onApiError(error));
  }

  // ------------------------------------------------------------------ state for React
  getState = (): AuthState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AuthState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private go(phase: Phase): void {
    this.set({ phase });
  }

  // ------------------------------------------------------------------ start, retry, enroll
  /** Is this PC enrolled, and does the server answer? Decides the first screen. */
  async start(): Promise<void> {
    let local: LocalDevice;
    let setup: SetupInfo | null;
    try {
      // Asked together, so a normal PC (no setup token) starts as fast as before.
      [local, setup] = await Promise.all([
        this.bridge.localDevice(),
        this.bridge.setupInfo().catch(() => null),
      ]);
    } catch {
      this.set({ server: 'down', phase: { name: 'signIn', notice: null } });
      return;
    }
    this.set({ device: local.device, suggestedCode: local.suggestedCode });
    if (setup?.available && setup.serverAddress && (await this.openSetup(setup))) {
      return;
    }
    if (!local.enrolled) {
      this.go({ name: 'enroll', notice: null });
      return;
    }
    try {
      const me = await this.api.get<ThisDeviceResponse>('/api/v1/devices/me');
      this.set({ device: me.device, server: 'ok' });
      if (this.state.phase.name === 'starting' || this.state.phase.name === 'enroll') {
        this.go({ name: 'signIn', notice: null });
      }
    } catch (error) {
      // Device and version problems are routed by onApiError; a server that does not answer
      // still shows the sign-in screen, with the "server unreachable" message.
      if (error instanceof ApiError && error.isConnection && this.state.phase.name === 'starting') {
        this.go({ name: 'signIn', notice: null });
      }
    }
  }

  /**
   * The server PC right after installation: the setup token is here and setup is not complete →
   * the wizard. Anywhere else (no token, a normal PC) this changes nothing.
   */
  private async openSetup(info: SetupInfo): Promise<boolean> {
    try {
      const status = await this.setupApi.get<SetupStatusResponse>('/api/v1/setup/status');
      if (status.state === 'complete') return false;
      this.set({ server: 'ok' });
      this.go({
        name: 'setup',
        status,
        serverAddress: info.serverAddress!,
        windowsBuild: info.windowsBuild,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Restore from a backup (decision 0102): the native side finds the copies and runs it. */
  get restore(): Pick<Bridge, 'restoreCopies' | 'restoreStart' | 'restoreStatus'> {
    return this.bridge;
  }

  /** The wizard enrolls this PC as the POS (the normal protocol, decision 0024). */
  async enrollForSetup(input: Parameters<Bridge['enroll']>[0]) {
    const outcome = await this.bridge.enroll(input);
    if (outcome.ok && outcome.device) this.set({ device: outcome.device });
    return outcome;
  }

  /** Setup complete: on to the normal sign-in (the token is gone, so no wizard any more). */
  async setupFinished(): Promise<void> {
    this.go({ name: 'starting' });
    await this.start();
  }

  /** "Try again" on the server-unreachable message. True when the server answers now. */
  async retry(): Promise<boolean> {
    await this.start();
    return this.state.server === 'ok';
  }

  async enroll(input: Parameters<Bridge['enroll']>[0]) {
    const outcome = await this.bridge.enroll(input);
    if (outcome.ok) {
      this.set({ phase: { name: 'starting' } });
      await this.start();
    }
    return outcome;
  }

  // ------------------------------------------------------------------ signing in
  pinUsers(): Promise<PinUsersResponse> {
    return this.api.get<PinUsersResponse>(`${AUTH}/pin-users`);
  }

  async signInWithPassword(username: string, password: string): Promise<void> {
    const response = await this.api.post<SignInResponse>(`${AUTH}/sign-in`, {
      username,
      password,
    });
    this.keepPendingSecret(password);
    await this.signedIn(response);
  }

  async signInWithPin(userId: string, pin: string): Promise<void> {
    const response = await this.api.post<SignInResponse>(`${AUTH}/pin-sign-in`, { userId, pin });
    this.keepPendingSecret(pin);
    await this.signedIn(response);
  }

  async secondFactor(request: SecondFactorRequest): Promise<void> {
    const response = await this.api.post<SignInResponse>(`${AUTH}/second-factor`, request);
    await this.signedIn(response);
  }

  /** "Back" from the 2-step code: the half-finished sign-in is ended on the server too. */
  async cancelSignIn(): Promise<void> {
    await this.signOut();
  }

  private async signedIn(response: SignInResponse): Promise<void> {
    this.api.setToken(response.token);
    this.set({
      session: response.session,
      user: response.user,
      server: 'ok',
      trustDays: response.trustDays ?? null,
      serverReset: response.serverReset ?? null,
    });
    await this.next();
  }

  // ------------------------------------------------------------------ forgot password (0028)
  /** "Forgot your password?" → the recovery screen (phone code + one recovery code). */
  openPasswordRecovery(): void {
    this.go({ name: 'recoverPassword' });
  }

  backToSignIn(): void {
    this.go({ name: 'signIn', notice: null });
  }

  /** On success the person is signed in here; the next screen says how many codes are left. */
  async recoverPassword(request: RecoverPasswordRequest): Promise<void> {
    const response = await this.api.post<RecoverPasswordResponse>(
      `${AUTH}/recover-password`,
      request,
    );
    this.api.setToken(response.token);
    this.set({ session: response.session, user: response.user, server: 'ok', trustDays: null });
    this.go({ name: 'passwordRecovered', codesLeft: response.recoveryCodesLeft });
  }

  /** "Continue" after the new password was saved. */
  async passwordRecoveredSeen(): Promise<void> {
    await this.next();
  }

  /** After each step: the next screen the session needs. */
  private async next(): Promise<void> {
    const { session, user } = this.state;
    if (!session || !user) {
      this.go({ name: 'signIn', notice: null });
      return;
    }
    if (session.stage === 'second_factor') return this.go({ name: 'secondFactor' });
    if (session.pending === 'credential_change') {
      return this.go({
        name: 'changeCredential',
        credential: user.signInMethod === 'pin' ? 'pin' : 'password',
      });
    }
    if (session.pending === 'two_step_setup') return this.go({ name: 'twoStepSetup' });
    if (session.locked) return this.go({ name: 'locked' });
    this.pendingSecret = null;
    const me = await this.api.get<MeResponse>(`${AUTH}/me`);
    this.set({
      session: me.session,
      user: me.user,
      device: me.device,
      permissions: me.permissions,
    });
    this.lastActivity = Date.now();
    this.lastHeartbeat = Date.now();
    this.go({ name: 'app' });
  }

  // ------------------------------------------------------------------ required steps
  private keepPendingSecret(value: string): void {
    this.pendingSecret = { value, until: Date.now() + PENDING_SECRET_MS };
  }

  /** The temporary password/PIN typed at sign-in, if still fresh (so it is not asked twice). */
  get hasPendingSecret(): boolean {
    return this.pendingSecret !== null && this.pendingSecret.until > Date.now();
  }

  async changePassword(newPassword: string, currentPassword?: string): Promise<void> {
    const current = currentPassword ?? this.pendingValue();
    const session = await this.api.post<SessionView>(`${AUTH}/change-password`, {
      currentPassword: current,
      newPassword,
    });
    this.set({ session, serverReset: null });
    await this.next();
  }

  async changePin(newPin: string, current?: string): Promise<void> {
    const session = await this.api.post<SessionView>(`${AUTH}/change-pin`, {
      current: current ?? this.pendingValue(),
      newPin,
    });
    this.set({ session });
    await this.next();
  }

  private pendingValue(): string {
    if (!this.hasPendingSecret) throw new ApiError('VALIDATION_FAILED', 0);
    return this.pendingSecret!.value;
  }

  twoStepStart(): Promise<TwoStepStartResponse> {
    return this.api.post<TwoStepStartResponse>(`${AUTH}/two-step/start`);
  }

  async twoStepConfirm(code: string): Promise<void> {
    const response = await this.api.post<TwoStepConfirmResponse>(`${AUTH}/two-step/confirm`, {
      code,
    });
    this.api.setToken(response.token);
    this.set({ session: response.session, user: response.user });
    // The codes are shown once, now; they are not kept anywhere after this screen.
    this.go({ name: 'recoveryCodes', codes: response.recoveryCodes });
  }

  /** "I have saved them": the recovery codes leave memory. */
  async recoveryCodesSaved(): Promise<void> {
    await this.next();
  }

  // ------------------------------------------------------------------ lock, unlock, sign out
  /** "Lock screen": shown at once; problems (e.g. the session already ended) are routed. */
  async lock(): Promise<void> {
    try {
      const session = await this.api.post<SessionView>(`${AUTH}/lock`);
      this.set({ session });
    } catch {
      // onApiError already moved to the right screen.
    }
    if (this.state.session) this.go({ name: 'locked' });
  }

  async unlock(secret: string): Promise<void> {
    const session = await this.api.post<SessionView>(`${AUTH}/unlock`, { secret });
    this.set({ session });
    await this.next();
  }

  /** Ends the session on the server (if it answers) and on this PC. */
  async signOut(notice: SignInNotice = 'signedOut'): Promise<void> {
    try {
      if (this.api.hasSession) await this.api.post(`${AUTH}/sign-out`);
    } catch {
      // Ended here anyway; the server ends it at expiry or at the next sign-in on this PC.
    } finally {
      this.clearSession();
      this.go({ name: 'signIn', notice });
    }
  }

  private clearSession(): void {
    this.api.setToken(null);
    this.pendingSecret = null;
    this.set({ session: null, user: null, permissions: [], trustDays: null, serverReset: null });
  }

  // ------------------------------------------------------------------ server answers
  private onApiError(error: ApiError): void {
    const hadSession = this.state.session !== null;
    switch (error.code) {
      case 'SERVER_UNREACHABLE':
        this.set({ server: 'down' });
        return;
      case 'SERVER_UNTRUSTED':
        this.set({ server: 'untrusted' });
        return;
      case 'DEVICE_NOT_ENROLLED':
      case 'DEVICE_KEY_EXPIRED':
      case 'DEVICE_REVOKED':
        this.clearSession();
        this.set({
          server: 'ok',
          phase: {
            name: 'enroll',
            notice:
              error.code === 'DEVICE_REVOKED'
                ? 'revoked'
                : error.code === 'DEVICE_KEY_EXPIRED'
                  ? 'expired'
                  : null,
          },
        });
        return;
      case 'CLIENT_OUTDATED':
        this.clearSession();
        this.go({
          name: 'outdated',
          minVersion: typeof error.details.minVersion === 'string' ? error.details.minVersion : '',
        });
        return;
      case 'SESSION_EXPIRED':
      case 'SESSION_REQUIRED':
        if (hadSession) {
          this.clearSession();
          this.go({ name: 'signIn', notice: 'expired' });
        }
        return;
      case 'SESSION_LOCKED':
        if (hadSession) this.go({ name: 'locked' });
        return;
      default:
        this.set({ server: 'ok' });
    }
  }

  // ------------------------------------------------------------------ idle lock
  /**
   * Locks the screen after the idle time the server gave (POS 5 min, office 15 min). Typing and
   * clicking count as activity, and are passed on to the server now and then, so it does not
   * lock a session someone is using without calling it.
   */
  watchIdle(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    const onActivity = () => {
      this.lastActivity = Date.now();
      if (this.state.phase.name === 'app' && Date.now() - this.lastHeartbeat > HEARTBEAT_MS) {
        this.lastHeartbeat = Date.now();
        void this.api.get(`${AUTH}/me`).catch(() => undefined);
      }
    };
    const timer = setInterval(() => {
      const { phase, session } = this.state;
      if (phase.name !== 'app' || !session) return;
      if (Date.now() - this.lastActivity >= session.idleTimeoutSeconds * 1000) {
        this.go({ name: 'locked' });
        // A background call: the server records the idle lock itself (reason "idle").
        void this.api.get(`${AUTH}/me`, { background: true }).catch(() => undefined);
      }
    }, IDLE_CHECK_MS);
    events.forEach((name) => target.addEventListener(name, onActivity, { passive: true }));
    return () => {
      clearInterval(timer);
      events.forEach((name) => target.removeEventListener(name, onActivity));
    };
  }
}
