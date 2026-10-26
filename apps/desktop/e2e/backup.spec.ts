/**
 * Settings → System health (decision 0086) against the real server, in Arabic and English: the
 * owner sees what needs attention, asks for a backup now (it waits for the backup service), and
 * creates the backup key: the private key is shown once and must be confirmed by its last 6
 * characters; then only the public key is kept. The server PC card (M6.2 part H) shows the
 * disks, services, certificates, clock and the UPS, and the owner confirms the UPS.
 */
import { expect, signInAsOwner, snap, test } from './fixtures';

test('the owner opens System health, asks for a backup and creates the backup key', async ({
  page,
  open,
  t,
}) => {
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.settings') }).click();
  await page.getByRole('link', { name: t('settings:hub.backup') }).click();
  await expect(page.getByRole('heading', { name: t('settings:backup.title') })).toBeVisible();
  await expect(page.getByTestId('health-problems')).toBeVisible();

  // The server PC (M6.2 part H): one line each; the owner confirms the UPS once.
  const server = page.getByTestId('server-health');
  await expect(server.getByTestId('health-disk-data')).toContainText(
    t('settings:serverHealth.disk.data'),
  );
  await expect(server.getByTestId('health-services')).toContainText(
    t('settings:serverHealth.services.databaseServer'),
  );
  await expect(server.getByTestId('health-clock')).toContainText(
    t('settings:serverHealth.clock.title'),
  );
  const ups = server.getByTestId('health-ups');
  const confirm = ups.getByRole('button', { name: t('settings:serverHealth.ups.confirm') });
  if (await confirm.isVisible()) await confirm.click();
  await expect(ups.getByRole('button')).toHaveCount(0);
  await snap(page, '93-server-health');

  await page.getByRole('button', { name: t('settings:backup.backupNow') }).click();
  await expect(page.getByTestId('backup-requests')).toContainText(
    t('settings:backup.kind.backup_now'),
  );

  const keyButton = page.getByRole('button', {
    name: new RegExp(`^(${t('settings:backup.createKey')}|${t('settings:backup.replaceKey')})$`),
  });
  await keyButton.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: t('settings:backup.createKey') }).click();
  const key = (await dialog.getByTestId('backup-key').locator('b').textContent())!.trim();
  expect(key).toMatch(/^AGE-SECRET-KEY-1/);
  await snap(page, '95-backup-key-once');
  await dialog.getByLabel(t('settings:backup.keyLast6')).fill(key.slice(-6));
  await dialog.getByRole('button', { name: t('settings:backup.keyDone') }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('health-key')).toContainText(t('settings:backup.keySet'));
  await snap(page, '94-system-health');
});
