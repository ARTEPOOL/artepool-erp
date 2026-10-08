/**
 * Development only: the Vite dev server plays the PC's native side, so the screens can run in a
 * normal browser (`pnpm dev:desktop:web`). The screens call three local endpoints:
 *
 *   GET  /__artepool/device   → LocalDevice
 *   POST /__artepool/enroll   → EnrollOutcome
 *   POST /__artepool/request  → BridgeResponse
 *
 * Only pages served by this dev server may call them (same origin), so another web page open in
 * the same browser cannot use this PC's device key.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { repoRoot } from '@artepool/node-kit';
import { BridgeRequest, EnrollInput } from '@artepool/shared/contracts';
import { DevBridge } from './bridge';

export interface DevBridgePluginOptions {
  clientVersion: string;
  /** Defaults to ARTEPOOL_DEV_DEVICE_FILE, then `.secrets/dev-device.json`. */
  deviceFile?: string;
}

/** Excel imports send up to 5 MB as base64 inside JSON (decision 0031). */
const MAX_BODY = 8 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch (error) {
        reject(new Error('invalid JSON', { cause: error }));
      }
    });
    request.on('error', reject);
  });
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

/** Same-origin pages only: the browser tells us where a request comes from. */
export function sameOrigin(request: IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== request.headers.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function artepoolDevBridge(options: DevBridgePluginOptions): Plugin {
  const deviceFile =
    options.deviceFile ??
    process.env.ARTEPOOL_DEV_DEVICE_FILE ??
    join(repoRoot, '.secrets', 'dev-device.json');
  const bridge = new DevBridge({ deviceFile, clientVersion: options.clientVersion });

  return {
    name: 'artepool-dev-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__artepool', (request, response) => {
        void (async () => {
          if (!sameOrigin(request)) return reply(response, 403, { error: 'forbidden' });
          const route = `${request.method} ${request.url?.split('?')[0]}`;
          try {
            if (route === 'GET /device') return reply(response, 200, await bridge.localDevice());
            if (request.method !== 'POST' || !request.headers['content-type']?.includes('json')) {
              return reply(response, 404, { error: 'not found' });
            }
            if (route === 'POST /enroll') {
              const input = EnrollInput.safeParse(await readBody(request));
              if (!input.success) return reply(response, 400, { error: 'invalid' });
              return reply(response, 200, await bridge.enroll(input.data));
            }
            if (route === 'POST /request') {
              const input = BridgeRequest.safeParse(await readBody(request));
              if (!input.success) return reply(response, 400, { error: 'invalid' });
              return reply(response, 200, await bridge.request(input.data));
            }
            return reply(response, 404, { error: 'not found' });
          } catch (error) {
            server.config.logger.error(`[artepool-dev-bridge] ${(error as Error).message}`);
            return reply(response, 500, { error: 'bridge failed' });
          }
        })();
      });
    },
  };
}
