/** Small helpers for the server-console commands: database connection and private prompts. */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { connectionFor, loadEnv } from '@artepool/node-kit';
import { SecretHasher } from '../platform/crypto/hashing';
import { createDb, createPool, type Db } from '../platform/db/pool';
import { SettingsCache } from '../platform/settings';
import { ConsoleError } from './bootstrap';

export interface ConsoleDeps {
  db: Db;
  hasher: SecretHasher;
  settings: SettingsCache;
}

export function openConsole(): ConsoleDeps {
  loadEnv();
  const db = createDb(createPool(connectionFor('api'), 2));
  return { db, hasher: new SecretHasher(), settings: new SettingsCache(db) };
}

let reader: { rl: ReturnType<typeof createInterface>; lines: AsyncIterator<string> } | undefined;

/**
 * Asks one question. Lines are buffered, so answers piped in all at once (scripts, tests) are
 * read one per question instead of being lost.
 */
export async function ask(question: string): Promise<string> {
  stdout.write(question);
  if (!reader) {
    const rl = createInterface({ input: stdin, terminal: false });
    reader = { rl, lines: rl[Symbol.asyncIterator]() };
  }
  const next = await reader.lines.next();
  if (!stdin.isTTY) stdout.write('\n');
  if (next.done) throw new ConsoleError('No answer was given. Nothing was changed.');
  return next.value.trim();
}

export function closePrompts(): void {
  reader?.rl.close();
  reader = undefined;
}

/** Reads a secret without showing it on screen (falls back to a plain line when piped). */
export async function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY) return ask(question);
  closePrompts();
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          finish();
          reject(new ConsoleError('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    stdin.on('data', onData);
  });
}

/** Runs a console command: prints a ConsoleError plainly, anything else with its message. */
export async function runCommand(deps: ConsoleDeps, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(
      error instanceof ConsoleError
        ? error.message
        : `Failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    closePrompts();
    await deps.db.destroy();
  }
}
