/** `pnpm owner:create` — creates the first owner (decision 0025). Run on the server PC. */
import { createFirstOwner } from './bootstrap';
import { ask, askHidden, openConsole, runCommand } from './console';
import { ConsoleError } from './bootstrap';

const deps = openConsole();
await runCommand(deps, async () => {
  console.log('Create the first ARTÉPOOL owner. Nothing typed here is saved except as listed.');
  const username = (await ask('Username (e.g. mohammed): ')).toLowerCase();
  const displayNameAr = await ask('Name in Arabic: ');
  const displayNameEn = await ask('Name in English: ');
  const password = await askHidden('Password (at least 10 characters, not shown): ');
  const again = await askHidden('Type the password again: ');
  if (password !== again)
    throw new ConsoleError('The two passwords are different. Nothing was saved.');
  await createFirstOwner(deps.db, deps.hasher, deps.settings, {
    username,
    displayNameAr,
    displayNameEn,
    password,
  });
  console.log(`Owner "${username}" created and recorded in the audit log.`);
  console.log('Next: run "pnpm device:code" to enroll the first PC, then sign in there.');
  console.log('At the first sign-in you will set up the 2-step code on your phone.');
});
