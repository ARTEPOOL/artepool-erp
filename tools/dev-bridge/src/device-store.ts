/**
 * Where a development PC keeps its enrollment: the server address, the pinned ARTÉPOOL CA and
 * the device key. The Windows app keeps the same in Windows Credential Manager (T11); here it is
 * a file readable by its owner only, in `.secrets/` (ignored by Git).
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface StoredDevice {
  version: 1;
  serverUrl: string;
  caCertificatePem: string;
  deviceKey: string;
  /**
   * A new key sent to the server for renewal but not yet confirmed. If the answer was lost, the
   * server may already expect this one, so it is tried before giving up.
   */
  pendingKey?: string;
  keyExpiresAt: string;
  device: { id: string; code: string; name: string; kind: string };
}

export async function readDevice(file: string): Promise<StoredDevice | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const data = JSON.parse(text) as Partial<StoredDevice>;
  if (
    data.version !== 1 ||
    typeof data.serverUrl !== 'string' ||
    typeof data.caCertificatePem !== 'string' ||
    typeof data.deviceKey !== 'string' ||
    typeof data.keyExpiresAt !== 'string' ||
    typeof data.device !== 'object'
  ) {
    throw new Error(`${file} is not a valid device file.`);
  }
  return data as StoredDevice;
}

/** Writes atomically (temporary file + rename) with owner-only permissions. */
export async function writeDevice(file: string, device: StoredDevice): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(device, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}
