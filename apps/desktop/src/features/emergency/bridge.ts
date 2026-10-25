/**
 * How the emergency window (decision 0107) reaches the PC's native side: the Windows app's Rust
 * layer runs the console's programs through the launcher; in development, the Vite dev server
 * runs the same programs (`@artepool/dev-bridge`).
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  EmergencyAnswer,
  EmergencyCheck,
  EmergencyFailure,
  EmergencyInfo,
  EmergencyRun,
} from '@artepool/shared/contracts';

export interface EmergencyBridge {
  info(): Promise<EmergencyInfo>;
  check(): Promise<EmergencyAnswer<EmergencyCheck>>;
  run<T>(request: EmergencyRun): Promise<EmergencyAnswer<T>>;
  /** Opens `C:\ProgramData\ARTEPOOL\logs` in File Explorer. */
  openLogs(): Promise<boolean>;
}

const NOT_EMERGENCY: EmergencyInfo = { emergency: false, serverPc: false };

const failed = (error: unknown): { ok: false; reason: EmergencyFailure; detail?: string } =>
  String(error).includes('not_server_pc')
    ? { ok: false, reason: 'not_server_pc' }
    : { ok: false, reason: 'launch_failed', detail: String(error) };

export const tauriEmergency: EmergencyBridge = {
  async info() {
    try {
      return await invoke<EmergencyInfo>('emergency_info');
    } catch {
      return NOT_EMERGENCY;
    }
  },
  async check() {
    try {
      return { ok: true, result: await invoke<EmergencyCheck>('emergency_check') };
    } catch (error) {
      return failed(error);
    }
  },
  async run<T>(request: EmergencyRun) {
    try {
      return await invoke<EmergencyAnswer<T>>('emergency_run', { ...request });
    } catch (error) {
      return failed(error);
    }
  },
  async openLogs() {
    try {
      await invoke('emergency_open_logs');
      return true;
    } catch {
      return false;
    }
  },
};

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

/** Development: the page opened with `?emergency` plays the emergency window. */
export const devServerEmergency: EmergencyBridge = {
  async info() {
    if (!new URLSearchParams(window.location.search).has('emergency')) return NOT_EMERGENCY;
    try {
      const response = await fetch('/__artepool/emergency', { credentials: 'same-origin' });
      return response.ok ? ((await response.json()) as EmergencyInfo) : NOT_EMERGENCY;
    } catch {
      return NOT_EMERGENCY;
    }
  },
  async check() {
    try {
      return await post<EmergencyAnswer<EmergencyCheck>>('/__artepool/emergency/check', {});
    } catch (error) {
      return failed(error);
    }
  },
  async run<T>(request: EmergencyRun) {
    try {
      return await post<EmergencyAnswer<T>>('/__artepool/emergency/run', request);
    } catch (error) {
      return failed(error);
    }
  },
  async openLogs() {
    try {
      await post('/__artepool/emergency/logs', {});
      return true;
    } catch {
      return false;
    }
  },
};

export function defaultEmergencyBridge(): EmergencyBridge {
  return isTauri() ? tauriEmergency : devServerEmergency;
}
