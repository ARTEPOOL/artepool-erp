/** `pnpm device:code` — prints a one-time code to enroll a PC (decisions 0024, 0025). */
import { createConsoleCode } from './bootstrap';
import { openConsole, runCommand } from './console';

const deps = openConsole();
await runCommand(deps, async () => {
  const { code, expiresAt } = await createConsoleCode(deps.db, deps.settings);
  const until = expiresAt.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Dubai',
    hour: '2-digit',
    minute: '2-digit',
  });
  console.log(`Enrollment code: ${code}`);
  console.log(`Valid once, until ${until} (Al Ain time). Any earlier unused code no longer works.`);
  console.log("Type it on the new PC together with this server's address.");
});
