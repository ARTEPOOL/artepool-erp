import { z } from 'zod';
import { connectionFor, loadEnv, type PgConnection } from '@artepool/node-kit';

const settingsSchema = z.object({
  SERVER_HOST: z.string().min(1).default('127.0.0.1'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface ServerConfig {
  host: string;
  port: number;
  logLevel: z.infer<typeof settingsSchema>['LOG_LEVEL'];
  database: PgConnection;
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
  };
}
