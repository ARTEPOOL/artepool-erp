/**
 * "ARTÉPOOL – Emergency tool" in development (the Windows app's Rust layer does the same through
 * the launcher, decision 0107): each action runs the console's own program
 * (`apps/server/src/cli/emergency.ts`, through tsx) with its input on standard input.
 *
 * Which database: the setup file's `restore.env` (ARTEPOOL_DEV_SETUP_FILE, written by the screen
 * tests); otherwise the development settings from `.env`. There are no Windows services here:
 * they read as unknown, and the secrets as working when the database program could run.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from '@artepool/node-kit';
import type {
  EmergencyAnswer,
  EmergencyCheck,
  EmergencyDatabaseStatus,
  EmergencyInfo,
  EmergencyRun,
} from '@artepool/shared/contracts';
import { setupFiles } from './setup';

async function programEnv(): Promise<Record<string, string>> {
  const files = (await setupFiles()) as Awaited<ReturnType<typeof setupFiles>> & {
    restore?: { env?: Record<string, string> };
  };
  return files.restore?.env ?? {};
}

function runProgram<T>(action: string, input: unknown, env: Record<string, string>) {
  return new Promise<EmergencyAnswer<T>>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(repoRoot, 'apps', 'server', 'src', 'cli', 'emergency.ts'), action],
      { cwd: repoRoot, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let errors = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
    const launchFailed = (detail: string): EmergencyAnswer<T> => ({
      ok: false,
      reason: 'launch_failed',
      detail,
    });
    child.on('error', (error) => resolve(launchFailed(error.message)));
    child.on('close', () => {
      const line = out.trim().split('\n').pop() ?? '';
      try {
        const answer = JSON.parse(line) as EmergencyAnswer<T>;
        if (typeof answer.ok === 'boolean') return resolve(answer);
      } catch {
        // not the program's answer
      }
      resolve(launchFailed(errors.trim().split('\n').pop() || 'No answer.'));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function emergencyInfo(): EmergencyInfo {
  return { emergency: true, serverPc: true };
}

export async function emergencyRun(request: EmergencyRun): Promise<EmergencyAnswer<unknown>> {
  return runProgram(request.action, request.input, await programEnv());
}

export async function emergencyCheck(): Promise<EmergencyAnswer<EmergencyCheck>> {
  const database = await runProgram<EmergencyDatabaseStatus>('status', {}, await programEnv());
  return {
    ok: true,
    result: {
      services: { database: 'unknown', server: 'unknown', backup: 'unknown' },
      secrets: database.ok || database.reason !== 'launch_failed',
      database,
    },
  };
}
