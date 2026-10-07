import { join } from 'node:path';
import { z } from 'zod';
import { connectionFor, loadEnv, repoRoot, type PgConnection } from '@artepool/node-kit';

const settingsSchema = z.object({
  SERVER_HOST: z.string().min(1).default('127.0.0.1'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ARTEPOOL_MASTER_KEY_FILE: z.string().min(1).optional(),
  ARTEPOOL_TLS_DIR: z.string().min(1).optional(),
});

export interface ServerConfig {
  host: string;
  port: number;
  logLevel: z.infer<typeof settingsSchema>['LOG_LEVEL'];
  database: PgConnection;
  /** File holding the master key for SecretBox (development: `pnpm dev:secrets`). */
  masterKeyFile: string;
  /** Folder with the CA certificate and the server certificate and key (`pnpm tls:init`). */
  tlsDir: string;
}

/** Reads the server settings. Secrets come from the environment (.env in development; DPAPI in M6). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  loadEnv();
  const settings = settingsSchema.parse(env);
  return {
    host: settings.SERVER_HOST,
    port: settings.SERVER_PORT,
    logLevel: settings.LOG_LEVEL,
    database: connectionFor('api'),
    masterKeyFile: settings.ARTEPOOL_MASTER_KEY_FILE ?? join(repoRoot, '.secrets', 'master.key'),
    tlsDir: settings.ARTEPOOL_TLS_DIR ?? join(repoRoot, '.secrets', 'tls'),
  };
}
