/**
 * The first-run wizard's channel in development (the Windows app's Rust layer does the same with
 * the files the installer leaves in `C:\ProgramData\ARTEPOOL\setup`, decision 0102). It reads the
 * setup token and the CA certificate, and sends only setup steps, with the token, to this PC's own
 * server. The token never reaches the screens.
 *
 * Where it looks: ARTEPOOL_DEV_SETUP_FILE, a JSON file `{ serverAddress, caFile, tokenFile }` (the
 * screen tests write one per run); otherwise `localhost:3100`, `.secrets/tls/ca.crt` and
 * `.secrets/setup/token` (made by `pnpm dev:setup-token`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from '@artepool/node-kit';
import {
  SETUP_TOKEN_HEADER,
  SetupToken,
  type BridgeResponse,
  type SetupInfo,
  type SetupRequest,
} from '@artepool/shared/contracts';
import { serverUrlFrom } from './address';
import { ConnectionError, send } from './connection';

export interface SetupFiles {
  serverAddress: string;
  caFile: string;
  tokenFile: string;
}

export async function setupFiles(env: NodeJS.ProcessEnv = process.env): Promise<SetupFiles> {
  if (env.ARTEPOOL_DEV_SETUP_FILE) {
    return JSON.parse(await readFile(env.ARTEPOOL_DEV_SETUP_FILE, 'utf8')) as SetupFiles;
  }
  return {
    serverAddress: 'localhost:3100',
    caFile: join(env.ARTEPOOL_TLS_DIR || join(repoRoot, '.secrets', 'tls'), 'ca.crt'),
    tokenFile: env.ARTEPOOL_SETUP_TOKEN_FILE || join(repoRoot, '.secrets', 'setup', 'token'),
  };
}

interface SetupAccess {
  serverUrl: string;
  serverAddress: string;
  ca: string;
  token: string;
}

async function access(): Promise<SetupAccess | null> {
  try {
    const files = await setupFiles();
    const token = (await readFile(files.tokenFile, 'utf8')).trim();
    const serverUrl = serverUrlFrom(files.serverAddress);
    if (!SetupToken.safeParse(token).success || !serverUrl) return null;
    return {
      serverUrl,
      serverAddress: files.serverAddress,
      ca: await readFile(files.caFile, 'utf8'),
      token,
    };
  } catch {
    return null;
  }
}

/** Development is not on Windows: ARTEPOOL_DEV_WINDOWS_BUILD plays the PC's build (tests). */
function windowsBuild(env: NodeJS.ProcessEnv = process.env): number | null {
  const build = Number.parseInt(env.ARTEPOOL_DEV_WINDOWS_BUILD ?? '', 10);
  return Number.isInteger(build) && build > 0 ? build : null;
}

export async function setupInfo(): Promise<SetupInfo> {
  const found = await access();
  return {
    available: found !== null,
    serverAddress: found?.serverAddress ?? null,
    windowsBuild: windowsBuild(),
  };
}

export async function setupRequest(
  request: SetupRequest,
  clientVersion: string,
): Promise<BridgeResponse> {
  const found = await access();
  // The token is gone (setup completed): the server would refuse anyway.
  if (!found) return { kind: 'unreachable' };
  const headers: Record<string, string> = {
    [SETUP_TOKEN_HEADER]: found.token,
    'x-artepool-client': clientVersion,
    accept: 'application/json',
  };
  let body: Buffer | undefined;
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = Buffer.from(JSON.stringify(request.body), 'utf8');
  }
  try {
    const answer = await send(new URL(request.path, found.serverUrl), {
      method: request.method,
      headers,
      body,
      ca: found.ca,
    });
    const text = answer.body.toString('utf8');
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // not JSON: kept as text
    }
    return {
      kind: 'response',
      status: answer.status,
      contentType: answer.contentType,
      body: parsed,
    };
  } catch (error) {
    return {
      kind:
        error instanceof ConnectionError && error.kind === 'untrusted'
          ? 'untrusted'
          : 'unreachable',
    };
  }
}
