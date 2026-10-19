/**
 * Google Drive for the off-site copies (decision 0086), with the narrowest permission Google
 * offers: `drive.file`, so the app sees and changes only the files it uploaded itself. The owner
 * connects the dedicated backup account once with Google's device sign-in (a code typed at
 * google.com/device on any phone or PC); the refresh token is kept sealed with the master key in
 * a file on the server, never in the database or a log.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SecretBox } from '@artepool/node-kit';
import type { GoogleEndpoints } from './config';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SEAL_AAD = 'backup.google_drive';

export interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  connectedAt: string;
}

export class GoogleError extends Error {
  override readonly name = 'GoogleError';
  constructor(
    message: string,
    /** Google's error code (`authorization_pending`, `invalid_grant`, …) when it gave one. */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

// --------------------------------------------------------------------------- sealed credentials

export async function saveDriveCredentials(
  file: string,
  box: SecretBox,
  credentials: DriveCredentials,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const sealed = box.seal(Buffer.from(JSON.stringify(credentials), 'utf8'), SEAL_AAD);
  const partial = `${file}.partial`;
  await writeFile(partial, sealed.toString('base64'), { mode: 0o600 });
  await rename(partial, file);
  if (process.platform !== 'win32') await chmod(file, 0o600);
}

/** The saved credentials, or null when Google Drive is not connected. */
export async function loadDriveCredentials(
  file: string,
  box: SecretBox,
): Promise<DriveCredentials | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(
    box.open(Buffer.from(text.trim(), 'base64'), SEAL_AAD).toString('utf8'),
  ) as DriveCredentials;
}

// --------------------------------------------------------------------------- HTTP

async function call<T>(url: string, init: RequestInit, what: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(10 * 60 * 1000) });
  } catch (error) {
    throw new GoogleError(
      `${what}: Google could not be reached (${error instanceof Error ? error.message : 'network'})`,
    );
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Not JSON: the status says enough.
  }
  if (!response.ok) {
    const code = typeof body.error === 'string' ? body.error : null;
    throw new GoogleError(
      `${what}: Google answered ${response.status}${code ? ` (${code})` : ''}`,
      code,
    );
  }
  return body as T;
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

// --------------------------------------------------------------------------- device sign-in

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

/** Step 1: Google gives a short code the owner types at google.com/device. */
export async function startDeviceSignIn(
  google: GoogleEndpoints,
  clientId: string,
): Promise<DeviceCode> {
  const r = await call<{
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
  }>(
    `${google.oauth}/device/code`,
    form({ client_id: clientId, scope: DRIVE_SCOPE }),
    'Connect Google Drive',
  );
  return {
    deviceCode: r.device_code,
    userCode: r.user_code,
    verificationUrl: r.verification_url,
    expiresIn: r.expires_in,
    interval: r.interval,
  };
}

/**
 * Step 2, asked every few seconds: the refresh token once the owner approved, or null while
 * Google is still waiting. Throws when the owner refused or the code expired.
 */
export async function finishDeviceSignIn(
  google: GoogleEndpoints,
  client: { clientId: string; clientSecret: string },
  deviceCode: string,
): Promise<string | null> {
  try {
    const r = await call<{ refresh_token?: string; scope?: string }>(
      `${google.oauth}/token`,
      form({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      'Connect Google Drive',
    );
    if (!r.refresh_token)
      throw new GoogleError('Connect Google Drive: Google gave no lasting permission');
    return r.refresh_token;
  } catch (error) {
    if (
      error instanceof GoogleError &&
      (error.code === 'authorization_pending' || error.code === 'slow_down')
    ) {
      return null;
    }
    throw error;
  }
}

// --------------------------------------------------------------------------- Drive

async function accessToken(
  google: GoogleEndpoints,
  credentials: DriveCredentials,
): Promise<string> {
  const r = await call<{ access_token: string }>(
    `${google.oauth}/token`,
    form({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }),
    'Google Drive sign-in',
  );
  return r.access_token;
}

export interface DriveFile {
  id: string;
  name: string;
}

export class Drive {
  private constructor(
    private readonly google: GoogleEndpoints,
    private readonly token: string,
  ) {}

  static async open(google: GoogleEndpoints, credentials: DriveCredentials): Promise<Drive> {
    return new Drive(google, await accessToken(google, credentials));
  }

  private auth(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  /** Uploads one file (resumable upload, one request for the body). */
  async upload(name: string, body: Buffer): Promise<DriveFile> {
    const start = await fetch(`${this.google.upload}/files?uploadType=resumable&fields=id,name`, {
      method: 'POST',
      headers: this.auth({
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'application/octet-stream',
        'x-upload-content-length': String(body.length),
      }),
      body: JSON.stringify({ name, appProperties: { artepool: 'backup' } }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    const location = start?.ok ? start.headers.get('location') : null;
    if (!location) {
      throw new GoogleError(
        `Upload to Google Drive: could not start (${start?.status ?? 'network'})`,
      );
    }
    return call<DriveFile>(
      location,
      {
        method: 'PUT',
        headers: this.auth({ 'content-type': 'application/octet-stream' }),
        body: new Uint8Array(body),
      },
      'Upload to Google Drive',
    );
  }

  /** The backup copies this app uploaded (not in the trash). */
  async list(): Promise<DriveFile[]> {
    const q = encodeURIComponent(
      "appProperties has { key='artepool' and value='backup' } and trashed = false",
    );
    const r = await call<{ files?: DriveFile[] }>(
      `${this.google.api}/files?q=${q}&fields=files(id,name)&pageSize=1000&spaces=drive`,
      { headers: this.auth() },
      'Google Drive list',
    );
    return r.files ?? [];
  }

  /** Moves an old copy to the Drive trash (Google keeps it there for 30 days). */
  async trash(id: string): Promise<void> {
    await call(
      `${this.google.api}/files/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: this.auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ trashed: true }),
      },
      'Google Drive trash',
    );
  }
}
