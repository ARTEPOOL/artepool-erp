/** Enrolling a new PC with the one-time code (decision 0024), through the real protocol. */
import { rm } from 'node:fs/promises';
import { control, expect, snap, test } from './fixtures';
import { E2E } from './paths';

test.beforeEach(async () => {
  await rm(E2E.pcs.fresh.deviceFile, { force: true });
});

test('a wrong code is refused; the right code enrolls the PC and opens sign-in', async ({
  page,
  open,
  t,
  lang,
}) => {
  await open('fresh');
  await expect(page.getByRole('heading', { name: t('auth:enroll.title') })).toBeVisible();
  await expect(page.getByText(t('shell:device.notEnrolled'))).toBeVisible();
  await snap(page, '01-enroll');

  const address = new URL(await control.apiUrl()).host; // e.g. localhost:43125
  const code = await control.enrollmentCode();
  const deviceCode = `FRESH-${lang.toUpperCase()}`;
  await page.getByLabel(t('auth:enroll.server'), { exact: true }).fill(address);
  await page.getByLabel(t('auth:enroll.code'), { exact: true }).fill('ZZZ-ZZZ-ZZZ');
  await page.getByLabel(t('auth:enroll.name'), { exact: true }).fill(`Front desk ${lang}`);
  await page.getByLabel(t('auth:enroll.deviceCode'), { exact: true }).fill(deviceCode);
  await page.getByRole('button', { name: t('auth:enroll.kinds.office'), exact: true }).click();
  await page.getByRole('button', { name: t('auth:enroll.submit') }).click();
  await expect(page.getByText(t('auth:enroll.failures.not_genuine'))).toBeVisible({
    timeout: 30_000,
  });
  await snap(page, '02-enroll-wrong-code');

  await page.getByLabel(t('auth:enroll.code'), { exact: true }).fill(code.toLowerCase());
  await page.getByRole('button', { name: t('auth:enroll.submit') }).click();
  await expect(page.getByRole('heading', { name: t('auth:signIn.title') })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(deviceCode)).toBeVisible();
  await expect(page.getByText(`Front desk ${lang}`)).toBeVisible();
});
