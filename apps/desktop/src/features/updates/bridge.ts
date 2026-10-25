/** The desktop app's own updater (decision 0108), through the PC's secure side (Tauri). */
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface AppUpdate {
  version: string;
  notesAr: string | null;
  notesEn: string | null;
}

/** A newer signed version for this PC, or null (none, no internet, the server PC, the browser). */
export async function checkAppUpdate(): Promise<AppUpdate | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<AppUpdate | null>('app_update_check');
  } catch {
    // No internet, or no update list in this build: the update simply waits.
    return null;
  }
}

/** Downloads it, checks its signature, installs it and starts the new version. */
export function installAppUpdate(): Promise<void> {
  return invoke('app_update_install');
}
