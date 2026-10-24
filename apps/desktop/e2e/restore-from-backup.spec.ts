/**
 * Restore from a backup on a new server PC (decision 0102, M6.2 part E), in a real browser against
 * a real server, in Arabic and English: the shop's encrypted off-site copy is found on the USB
 * drive, the private key is loaded from the key file, the restore runs (separate database, every
 * check, the swap), this PC is enrolled with the restore's code, and a person of the shop signs in
 * with their old password and phone code.
 */
import { control, expect, snap, test, typeCode, unique } from './fixtures';

test.setTimeout(240_000);

test('restore the shop from its Google Drive copy, then sign in as before', async ({
  page,
  open,
  t,
  lang,
}) => {
  // The shop's data has someone with a password and a phone code; then its off-site copy.
  const username = unique('restored');
  const password = 'clear-pool-water-58';
  const person = await control.addTwoStepUser({
    username,
    password,
    recoveryCodes: [],
    displayNameAr: 'سارة المحاسبة',
    displayNameEn: 'Sara Accountant',
  });
  await control.setupServer();
  const copy = await control.restoreCopy();
  await open('setup');
  await page.getByRole('button', { name: t('firstRun:paths.restore.start') }).click();

  // The copy on the USB drive, found by itself and already chosen.
  await expect(
    page.getByRole('heading', { name: t('firstRun:restore.choose.title') }),
  ).toBeVisible();
  await expect(
    page.getByRole('radio', { name: new RegExp(copy.name.replace(/\./g, '\\.')) }),
  ).toBeChecked();
  await snap(page, '100-restore-choose');
  await page.getByRole('button', { name: t('firstRun:restore.choose.next') }).click();

  // The private key from the key file (comment lines and all).
  await expect(page.getByRole('heading', { name: t('firstRun:restore.key.title') })).toBeVisible();
  await page.getByLabel(t('firstRun:restore.key.file')).setInputFiles(copy.keyFile);
  await expect(
    page.getByRole('heading', { name: t('firstRun:restore.confirm.title') }),
  ).toBeVisible();
  await page.getByRole('button', { name: t('firstRun:restore.confirm.start') }).click();

  // The restore runs, then every check has passed.
  await expect(
    page.getByRole('heading', { name: t('firstRun:restore.restored.title') }),
  ).toBeVisible({
    timeout: 180_000,
  });
  await snap(page, '101-restore-done');
  await page.getByRole('button', { name: t('firstRun:restore.restored.toEnroll') }).click();

  // This PC, enrolled as the POS with the code the restore made.
  await page
    .getByLabel(t('firstRun:device.code'), { exact: true })
    .fill(`RESTORED-${lang.toUpperCase()}`);
  await page.getByRole('button', { name: t('firstRun:device.enroll') }).click();
  await expect(page.getByRole('heading', { name: t('firstRun:done.title') })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: t('firstRun:done.button') }).click();

  // Their old password and phone code work on the restored server.
  await expect(page.getByRole('heading', { name: t('auth:pin.title') })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: t('auth:signIn.password'), exact: true }).click();
  await page.getByLabel(t('auth:signIn.username'), { exact: true }).fill(username);
  await page.getByLabel(t('auth:signIn.password'), { exact: true }).fill(password);
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
  await typeCode(page, await control.codeFor(person.id));
  await page.getByRole('button', { name: t('auth:secondFactor.confirm') }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible({
    timeout: 30_000,
  });
});
