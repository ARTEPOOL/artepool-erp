/** A stand-in for the PC's native side: scripted server answers, and a record of every call. */
import type {
  BridgeRequest,
  BridgeResponse,
  EnrollInput,
  EnrollOutcome,
  LocalDevice,
  SessionView,
  SetupInfo,
  SetupRequest,
  SignInResponse,
  UserView,
} from '@artepool/shared/contracts';
import type { Bridge } from '../../src/api/bridge';

export type Answer = BridgeResponse | ((request: BridgeRequest) => BridgeResponse);

export const ok = (body: unknown, status = 200): BridgeResponse => ({
  kind: 'response',
  status,
  contentType: 'application/json; charset=utf-8',
  body,
});

export const failure = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): BridgeResponse => ok({ error: { code, details } }, status);

export const OFFICE = { id: '2', code: 'OFFICE-01', name: 'Owner office', kind: 'office' };
export const POS = { id: '3', code: 'COUNTER-01', name: 'Showroom counter', kind: 'pos' };

export function sessionView(patch: Partial<SessionView> = {}): SessionView {
  return {
    stage: 'full',
    authMethod: 'password',
    pending: null,
    locked: false,
    expiresAt: '2026-10-08T00:00:00.000Z',
    idleTimeoutSeconds: 900,
    ...patch,
  };
}

export function userView(patch: Partial<UserView> = {}): UserView {
  return {
    id: '5',
    username: 'sara.office',
    displayNameAr: 'سارة علي',
    displayNameEn: 'Sara Ali',
    language: 'ar',
    signInMethod: 'password',
    ...patch,
  };
}

export const signInAnswer = (
  session: Partial<SessionView> = {},
  user: Partial<UserView> = {},
  token = 'token-1',
): SignInResponse => ({ token, session: sessionView(session), user: userView(user) });

export class FakeBridge implements Bridge {
  local: LocalDevice;
  enrollOutcome: EnrollOutcome = { ok: false, reason: 'not_genuine' };
  readonly calls: BridgeRequest[] = [];
  readonly enrollCalls: EnrollInput[] = [];
  /** The first-run wizard: off unless a test turns it on. */
  setup: SetupInfo = { available: false, serverAddress: null, windowsBuild: null };
  readonly setupCalls: SetupRequest[] = [];
  private readonly answers = new Map<string, Answer[]>();

  constructor(device: typeof OFFICE | null = OFFICE) {
    this.local = {
      enrolled: device !== null,
      serverUrl: device ? 'https://artepool-server:3100' : null,
      device,
      suggestedCode: 'NEW-PC',
    };
    if (device) this.on('GET', '/api/v1/devices/me', ok({ device, keyExpiresAt: '2027-10-07' }));
  }

  /** Answers for one route, used in order; the last one repeats. */
  on(method: string, path: string, ...answers: Answer[]): this {
    this.answers.set(`${method} ${path}`, answers);
    return this;
  }

  /** Calls made to one route (method and path). */
  callsTo(method: string, path: string): BridgeRequest[] {
    return this.calls.filter(
      (c) => c.method === method && (c.path === path || c.path.split('?')[0] === path),
    );
  }

  localDevice(): Promise<LocalDevice> {
    return Promise.resolve(this.local);
  }

  enroll(input: EnrollInput): Promise<EnrollOutcome> {
    this.enrollCalls.push(input);
    return Promise.resolve(this.enrollOutcome);
  }

  setupInfo(): Promise<SetupInfo> {
    return Promise.resolve(this.setup);
  }

  /** Setup steps share the scripted answers (their paths are /api/v1/setup/…). */
  setupRequest(request: SetupRequest): Promise<BridgeResponse> {
    this.setupCalls.push(request);
    return this.answer(request);
  }

  request(request: BridgeRequest): Promise<BridgeResponse> {
    this.calls.push(request);
    return this.answer(request);
  }

  private answer(request: BridgeRequest): Promise<BridgeResponse> {
    // An exact path first, then the same path without its query (?limit=…).
    const list =
      this.answers.get(`${request.method} ${request.path}`) ??
      this.answers.get(`${request.method} ${request.path.split('?')[0]}`);
    if (!list || list.length === 0) return Promise.resolve(failure(404, 'NOT_FOUND'));
    const answer = list.length > 1 ? list.shift()! : list[0]!;
    return Promise.resolve(typeof answer === 'function' ? answer(request) : answer);
  }
}
