/**
 * `pnpm owner:reset-password` — emergency password reset for the owner (decision 0029), when the
 * password is lost and "Forgot your password?" cannot be used. Works only on the server PC and
 * is recorded in the audit log.
 */
import { ConsoleError, resetOwnerPassword } from './bootstrap';
import { ask, openConsole, runCommand } from './console';

const deps = openConsole();
await runCommand(deps, async () => {
  console.log('Emergency reset of the owner password. Use it only if the password is lost AND');
  console.log('"Forgot your password?" cannot be used (the phone or the recovery codes are lost).');
  console.log(
    'If you still have the phone and a recovery code, use "Forgot your password?" instead.',
  );
  const reason = await ask('Why is this needed? (required, kept in the audit log): ');
  if (reason.trim().length < 3) {
    throw new ConsoleError('A reason of at least 3 characters is required. Nothing was changed.');
  }
  const phone = (await ask('Is the phone with the 2-step code lost too? (yes/no): ')).toLowerCase();
  if (!['yes', 'no', 'y', 'n'].includes(phone)) {
    throw new ConsoleError('Answer yes or no. Nothing was changed.');
  }
  const confirm = await ask('Type RESET to continue: ');
  if (confirm !== 'RESET') throw new ConsoleError('Not confirmed. Nothing was changed.');
  const phoneLost = phone.startsWith('y');
  const result = await resetOwnerPassword(deps.db, deps.hasher, { reason, phoneLost });
  console.log('');
  console.log(
    `Temporary password for "${result.username}" (shown once): ${result.temporaryPassword}`,
  );
  console.log('Sign in with it on an enrolled PC; you will choose your own password at once.');
  console.log(
    phoneLost
      ? 'The 2-step code was cleared: after the password, you will set up your phone again.'
      : 'You will still need the 6-digit code from your phone.',
  );
  console.log(
    'All your sessions ended, no PC is trusted any more, and the reset is in the audit log.',
  );
});
