/**
 * The native side of the screens in development (the Windows app's Rust layer does the same).
 * It holds the device key, enrolls the PC, renews the key, and sends API requests.
 */
import { hostname } from 'node:os';
import {
  clientProofMessage,
  enrollTranscript,
  serverProofMessage,
  type BridgeRequest,
  type BridgeResponse,
  type EnrollCompleteResponse,
  type EnrollHelloResponse,
  type EnrollInput,
  type EnrollOutcome,
  type LocalDevice,
  type RenewKeyResponse,
} from '@artepool/shared/contracts';
import { serverUrlFrom } from './address';
import { ConnectionError, issuedFor, send, type HttpAnswer } from './connection';
import { readDevice, writeDevice, type StoredDevice } from './device-store';
import { caFingerprint, deriveCodeKey, keyHash, proof, random32 } from './enroll-client';

/** Renew the device key this long before it expires (the server accepts it from then). */
const RENEW_BEFORE_MS = 30 * 86_400_000;

export interface DevBridgeOptions {
  /** Where the enrollment is kept (`.secrets/dev-device.json` by default). */
  deviceFile: string;
  /** Sent as `x-artepool-client`, so the server can refuse outdated apps. */
  clientVersion: string;
  /** Test hook: the computer name suggested as the device code. */
  computerName?: string;
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

function parse(answer: HttpAnswer): unknown {
  const text = answer.body.toString('utf8');
  if (answer.contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

const errorCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } } | null)?.error?.code;

/** The Windows computer name, made into a valid device code (e.g. `COUNTER-01`). */
export function suggestedCode(name = hostname()): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '-')
    .replace(/^[^A-Z0-9]+/, '')
    .slice(0, 32);
  return cleaned || 'PC-01';
}

export class DevBridge {
  private renewing: Promise<void> | null = null;

  constructor(private readonly options: DevBridgeOptions) {}

  async localDevice(): Promise<LocalDevice> {
    const stored = await readDevice(this.options.deviceFile);
    return {
      enrolled: stored !== null,
      serverUrl: stored?.serverUrl ?? null,
      suggestedCode: suggestedCode(this.options.computerName),
    };
  }

  /** Enrollment protocol v1 (decision 0024): the code proves the server, then the PC. */
  async enroll(input: EnrollInput): Promise<EnrollOutcome> {
    const serverUrl = serverUrlFrom(input.serverAddress);
    if (!serverUrl) return { ok: false, reason: 'invalid_address' };
    const base = new URL(serverUrl);
    const headers = {
      'content-type': 'application/json',
      'x-artepool-client': this.options.clientVersion,
    };

    // 1. hello: the PC does not know the CA yet, so this answer is checked by its proof.
    const clientNonce = random32();
    let helloAnswer: HttpAnswer;
    try {
      helloAnswer = await send(new URL('/api/v1/enroll/hello', base), {
        method: 'POST',
        headers,
        body: json({ clientNonce }),
        ca: null,
      });
    } catch (error) {
      return { ok: false, reason: failureOf(error) };
    }
    if (helloAnswer.status === 429) return { ok: false, reason: 'rate_limited' };
    if (helloAnswer.status !== 200) return { ok: false, reason: statusFailure(helloAnswer) };
    const hello = parse(helloAnswer) as EnrollHelloResponse;
    if (typeof hello.caCertificatePem !== 'string' || typeof hello.serverProof !== 'string') {
      return { ok: false, reason: 'not_genuine' };
    }

    // 2. Only someone who knows the code can make this proof: the genuine server.
    const codeKey = await deriveCodeKey(input.code, Buffer.from(hello.keySalt, 'base64url'));
    const transcript = enrollTranscript(
      clientNonce,
      hello.serverNonce,
      caFingerprint(hello.caCertificatePem),
    );
    if (proof(codeKey, serverProofMessage(transcript)) !== hello.serverProof) {
      return { ok: false, reason: 'not_genuine' };
    }
    // …and the hello itself came from a server that CA vouches for, under this name.
    if (!issuedFor(helloAnswer.peerCertificate, hello.caCertificatePem, base)) {
      return { ok: false, reason: 'not_genuine' };
    }

    // 3. complete, over TLS that trusts only that CA. The PC makes its own key.
    const deviceKey = random32();
    const device = {
      deviceCode: input.deviceCode,
      deviceName: input.deviceName,
      deviceKind: input.deviceKind,
      deviceKeyHash: keyHash(deviceKey),
    };
    let completeAnswer: HttpAnswer;
    try {
      completeAnswer = await send(new URL('/api/v1/enroll/complete', base), {
        method: 'POST',
        headers,
        body: json({
          clientNonce,
          serverNonce: hello.serverNonce,
          ...device,
          clientProof: proof(codeKey, clientProofMessage(transcript, device)),
        }),
        ca: hello.caCertificatePem,
      });
    } catch (error) {
      return { ok: false, reason: failureOf(error) };
    }
    if (completeAnswer.status === 429) return { ok: false, reason: 'rate_limited' };
    if (completeAnswer.status !== 201) return { ok: false, reason: statusFailure(completeAnswer) };
    const done = parse(completeAnswer) as EnrollCompleteResponse;
    await writeDevice(this.options.deviceFile, {
      version: 1,
      serverUrl,
      caCertificatePem: hello.caCertificatePem,
      deviceKey,
      keyExpiresAt: done.keyExpiresAt,
      device: done.device,
    });
    return { ok: true, serverUrl, device: done.device };
  }

  /** One API request with this PC's key; renews the key first when it is due. */
  async request(request: BridgeRequest): Promise<BridgeResponse> {
    let stored = await readDevice(this.options.deviceFile);
    if (!stored) return { kind: 'not_enrolled' };
    if (Date.parse(stored.keyExpiresAt) - Date.now() < RENEW_BEFORE_MS) {
      this.renewing ??= this.renew(stored).finally(() => (this.renewing = null));
      await this.renewing;
      stored = (await readDevice(this.options.deviceFile)) ?? stored;
    }
    try {
      let answer = await this.sendWith(stored, stored.deviceKey, request);
      if (answer.kind === 'response' && stored.pendingKey && notEnrolled(answer)) {
        // A renewal whose answer was lost: the server may already expect the new key.
        const retry = await this.sendWith(stored, stored.pendingKey, request);
        if (retry.kind === 'response' && !notEnrolled(retry)) {
          await writeDevice(this.options.deviceFile, {
            ...stored,
            deviceKey: stored.pendingKey,
            pendingKey: undefined,
          });
          answer = retry;
        }
      }
      return answer;
    } catch (error) {
      return { kind: failureOf(error) === 'unreachable' ? 'unreachable' : 'untrusted' };
    }
  }

  private async sendWith(
    stored: StoredDevice,
    deviceKey: string,
    request: BridgeRequest,
  ): Promise<BridgeResponse> {
    const headers: Record<string, string> = {
      'x-artepool-device': deviceKey,
      'x-artepool-client': this.options.clientVersion,
      accept: 'application/json, text/csv',
    };
    if (request.token) headers.authorization = `Bearer ${request.token}`;
    if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey;
    if (request.background) headers['x-artepool-background'] = '1';
    let body: Buffer | undefined;
    if (request.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = json(request.body);
    }
    const answer = await send(new URL(request.path, stored.serverUrl), {
      method: request.method,
      headers,
      body,
      ca: stored.caCertificatePem,
    });
    return {
      kind: 'response',
      status: answer.status,
      contentType: answer.contentType,
      body: parse(answer),
    };
  }

  /** Key renewal (decision 0024): a new key, saved as pending before the server sees it. */
  private async renew(stored: StoredDevice): Promise<void> {
    const newKey = stored.pendingKey ?? random32();
    await writeDevice(this.options.deviceFile, { ...stored, pendingKey: newKey });
    try {
      const answer = await this.sendWith(stored, stored.deviceKey, {
        method: 'POST',
        path: '/api/v1/devices/me/renew-key',
        body: { newKeyHash: keyHash(newKey) },
      });
      if (answer.kind !== 'response' || answer.status !== 200) return;
      const result = answer.body as RenewKeyResponse;
      await writeDevice(this.options.deviceFile, {
        ...stored,
        deviceKey: result.renewed ? newKey : stored.deviceKey,
        pendingKey: undefined,
        keyExpiresAt: result.keyExpiresAt,
      });
    } catch {
      // Not reachable now: the next request tries again; the pending key is kept.
    }
  }
}

const notEnrolled = (answer: Extract<BridgeResponse, { kind: 'response' }>) =>
  answer.status === 401 && errorCode(answer.body) === 'DEVICE_NOT_ENROLLED';

function failureOf(error: unknown): 'unreachable' | 'not_genuine' {
  return error instanceof ConnectionError && error.kind === 'untrusted'
    ? 'not_genuine'
    : 'unreachable';
}

function statusFailure(answer: HttpAnswer): 'code_rejected' | 'unavailable' | 'not_genuine' {
  const code = errorCode(parse(answer));
  if (code === 'ENROLLMENT_FAILED') return 'code_rejected';
  if (code === 'ENROLLMENT_UNAVAILABLE') return 'unavailable';
  return answer.status >= 500 ? 'unavailable' : 'not_genuine';
}
