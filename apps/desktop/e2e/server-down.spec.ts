/** Design 01 "server down": the message, sign-in disabled, and "Try again". */
import { control, expect, snap, test } from './fixtures';

test('main server unreachable, then back after "Try again"', async ({ page, open, t }) => {
  await control.stopServer();
  try {
    await open('office');
    await expect(page.getByText(t('auth:server.down'))).toBeVisible();
    await expect(page.getByText(t('shell:server.unreachable'))).toBeVisible();
    await expect(page.getByRole('button', { name: t('auth:signIn.submit') })).toBeDisabled();
    await snap(page, '13-server-down');
  } finally {
    await control.startServer();
  }
  await page.getByRole('button', { name: t('auth:server.retry') }).click();
  await expect(page.getByText(t('auth:server.back'))).toBeVisible();
  await expect(page.getByText(t('shell:server.connected'))).toBeVisible();
  await expect(page.getByRole('button', { name: t('auth:signIn.submit') })).toBeEnabled();
});
