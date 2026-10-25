/**
 * `artepool-svc run restore <copy file>` — the restore from a backup on a new server PC (decision
 * 0102), started by the first-run wizard as a Windows administrator. The owner's private key comes
 * on the standard input (one line; empty for a plain copy from the external drive). Progress and
 * the result are JSON lines on the standard output (restore-from-backup.ts).
 */
import { readFile } from 'node:fs/promises';
import { stdin } from 'node:process';
import { loadEnv } from '@artepool/node-kit';
import { askHidden, closePrompts } from './console';
import { restoreFromBackup, type RestoreMessage } from './restore-from-backup';

async function privateKey(): Promise<string | null> {
  let text: string;
  if (stdin.isTTY) {
    text = await askHidden('Private key (AGE-SECRET-KEY-1…; empty for a plain copy): ');
    closePrompts();
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    text = Buffer.concat(chunks).toString('utf8');
  }
  return text.trim() || null;
}

const report = (message: RestoreMessage) => process.stdout.write(`${JSON.stringify(message)}\n`);

loadEnv();
const copyFile = process.argv[2];
if (!copyFile) {
  console.error('Use: restore <copy file>  (the private key on the standard input)');
  process.exit(2);
}
try {
  const result = await restoreFromBackup({
    copy: await readFile(copyFile),
    privateKey: await privateKey(),
    report,
  });
  report({ result });
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  report({
    result: {
      ok: false,
      reason: 'restore_failed',
      detail: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
}
