/**
 * `pnpm owner:reset-2fa` — emergency reset when the owner lost both the phone and the recovery
 * codes (decision 0022). Works only on the server PC and is recorded in the audit log.
 */
import { ConsoleError, resetOwnerTwoStep } from './bootstrap';
import { ask, openConsole, runCommand } from './console';

const deps = openConsole();
await runCommand(deps, async () => {
  console.log('Emergency reset of the owner 2-step code. Use it only if the phone AND the');
  console.log(
    'recovery codes are both lost. The owner will set up a new phone at the next sign-in.',
  );
  const reason = await ask('Why is this needed? (required, kept in the audit log): ');
  const confirm = await ask('Type RESET to continue: ');
  if (confirm !== 'RESET') throw new ConsoleError('Not confirmed. Nothing was changed.');
  const username = await resetOwnerTwoStep(deps.db, reason);
  console.log(`The 2-step code of "${username}" was reset and all their sessions ended.`);
  console.log('Recorded in the audit log with your reason.');
});
