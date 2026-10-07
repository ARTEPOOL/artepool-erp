/**
 * How the screens reach the PC's native side (see `@artepool/shared/contracts` bridge). The
 * screens never hold the device key and never connect to the server themselves.
 */
import type {
  BridgeRequest,
  BridgeResponse,
  EnrollInput,
  EnrollOutcome,
  LocalDevice,
} from '@artepool/shared/contracts';

export interface Bridge {
  localDevice(): Promise<LocalDevice>;
  enroll(input: EnrollInput): Promise<EnrollOutcome>;
  request(request: BridgeRequest): Promise<BridgeResponse>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`bridge ${path}: ${response.status}`);
  return (await response.json()) as T;
}

/** Development in a browser: the Vite dev server plays the native side (`@artepool/dev-bridge`). */
export const devServerBridge: Bridge = {
  async localDevice() {
    const response = await fetch('/__artepool/device', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`bridge device: ${response.status}`);
    return (await response.json()) as LocalDevice;
  },
  async enroll(input) {
    try {
      return await post<EnrollOutcome>('/__artepool/enroll', input);
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  },
  async request(request) {
    try {
      return await post<BridgeResponse>('/__artepool/request', request);
    } catch {
      return { kind: 'unreachable' };
    }
  },
};

/** The bridge of this build. The Windows app (T11) replaces it with calls into Rust. */
export function defaultBridge(): Bridge {
  return devServerBridge;
}
