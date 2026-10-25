/**
 * `artepool-svc run emergency <action>` — the program behind "ARTÉPOOL – Emergency tool"
 * (decision 0107). Its input is one JSON object on standard input; its answer is one JSON line
 * on standard output, nothing else. The window shows the answer; it is never logged.
 */
import { stdin, stdout } from 'node:process';
import { openConsole, type ConsoleDeps } from './console';
import { runEmergencyAction, type EmergencyAnswer } from './emergency-actions';

async function readInput(): Promise<unknown> {
  if (stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? {} : (JSON.parse(text) as unknown);
}

let deps: ConsoleDeps | undefined;
let answer: EmergencyAnswer;
try {
  const input = await readInput();
  deps = openConsole();
  answer = await runEmergencyAction(deps, process.argv[2] ?? '', input);
} catch (error) {
  answer =
    error instanceof SyntaxError
      ? { ok: false, reason: 'bad_input' }
      : {
          ok: false,
          reason: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        };
} finally {
  await deps?.db.destroy();
}
stdout.write(`${JSON.stringify(answer)}\n`);
process.exitCode = answer.ok ? 0 : 1;
