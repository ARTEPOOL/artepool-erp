/**
 * "Updating ARTEPOOL" (decision 0115, 0.9.0) against the real status page, in Arabic and English:
 * the server stops for an update and the status page takes its port; the next request is refused
 * and the app shows the steps as the page gives them; when the page closes it says the server is
 * starting; when the server answers again with the version the update was for, it says so.
 */
import { control, expect, signInAsOwner, snap, test } from './fixtures';

test('the app follows the update on the status page, then says it is updated', async ({
  page,
  open,
  t,
}) => {
  await open('office');
  await signInAsOwner(page, t);
  const version = await control.serverVersion();
  await control.updating('backup', version);
  try {
    // Any request now gets the status page's refusal.
    await page.getByRole('link', { name: t('settings:nav.settings') }).click();
    const updating = page.getByTestId('server-updating');
    await expect(updating).toBeVisible();
    await expect(updating.getByText(t('shell:serverUpdate.title'))).toBeVisible();
    const steps = updating.getByTestId('update-steps').getByRole('listitem');
    await expect(steps.nth(2)).toHaveAttribute(
      'aria-label',
      `${t('shell:serverUpdate.step.backup')}: ${t('shell:serverUpdate.state.running')}`,
    );
    await snap(page, '97-server-updating');

    await control.updating('database', version);
    await expect(steps.nth(3)).toHaveAttribute(
      'aria-label',
      `${t('shell:serverUpdate.step.database')}: ${t('shell:serverUpdate.state.running')}`,
    );
    await control.endUpdate();
    await expect(updating.getByText(t('shell:serverUpdate.restarting'))).toBeVisible();
  } finally {
    await control.endUpdate();
    await control.startServer();
  }
  const done = page.getByTestId('server-update-done');
  await expect(done).toBeVisible();
  await expect(done).toHaveAttribute('data-outcome', 'ok');
  await expect(done.getByText(t('shell:serverUpdate.done.ok.text', { to: version }))).toBeVisible();
  await done.getByRole('button', { name: t('shell:serverUpdate.ok') }).click();
  await expect(page.getByTestId('server-updating')).toHaveCount(0);
  await expect(page.getByRole('link', { name: t('settings:nav.settings') })).toBeVisible();
});
