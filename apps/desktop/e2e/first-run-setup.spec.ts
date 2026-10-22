/**
 * The first-run wizard on a server PC just installed (decisions 0092, 0102), in a real browser
 * against a real server on an empty database, in Arabic and English: company details, the owner,
 * the phone 2-step with a real authenticator code, the recovery codes, this PC enrolled as the
 * POS through the real protocol, finish; then the normal sign-in, and the wizard never again.
 */
import { authenticatorCode, control, expect, snap, test, typeCode } from './fixtures';

test.setTimeout(180_000);

test('a new setup from start to finish, then the normal sign-in', async ({
  page,
  open,
  t,
  lang,
}) => {
  await control.setupServer();
  await open('setup');
  await expect(page.getByRole('heading', { name: t('firstRun:title') })).toBeVisible();
  await expect(page.getByText(t('firstRun:paths.restore.soon'))).toBeVisible();
  await snap(page, '96-setup-welcome');
  await page.getByRole('button', { name: t('firstRun:paths.new.start') }).click();

  // 1. The company.
  const step = (n: number, name: string) =>
    page.getByText(t('firstRun:step', { n, total: 5, name: t(`firstRun:steps.${name}`) }));
  await expect(step(1, 'company')).toBeVisible();
  await page
    .getByLabel(t('setup:company.fields.legalNameAr'), { exact: true })
    .fill('آرتيبول لحمامات السباحة');
  await page
    .getByLabel(t('setup:company.fields.legalNameEn'), { exact: true })
    .fill('ARTEPOOL Swimming Pools');
  await page.getByText(t('setup:company.fields.vatRegistered'), { exact: true }).click();
  await page.getByLabel(t('setup:company.fields.trn'), { exact: true }).fill('100123456700003');
  await page.getByLabel(t('setup:company.fields.addressAr'), { exact: true }).fill('العين');
  await page.getByLabel(t('setup:company.fields.addressEn'), { exact: true }).fill('Al Ain');
  await snap(page, '97-setup-company');
  await page.getByRole('button', { name: t('firstRun:company.save') }).click();

  // 2. The owner.
  await expect(step(2, 'owner')).toBeVisible();
  await page.getByLabel(t('firstRun:owner.username'), { exact: true }).fill(`mohammed${lang}`);
  await page.getByLabel(t('firstRun:owner.nameAr'), { exact: true }).fill('محمد ياسر');
  await page.getByLabel(t('firstRun:owner.nameEn'), { exact: true }).fill('Mohammed Yasser');
  await page.getByLabel(t('firstRun:owner.password'), { exact: true }).fill('blue-pool-water-71');
  await page.getByLabel(t('firstRun:owner.again'), { exact: true }).fill('blue-pool-water-71');
  await page.getByRole('button', { name: t('firstRun:owner.save') }).click();

  // 3. The phone 2-step: the key shown under the QR code, typed into an authenticator.
  await expect(step(3, 'twoStep')).toBeVisible();
  const key = (await page.locator('code').first().textContent())!.replace(/\s/g, '');
  await snap(page, '98-setup-two-step');
  await typeCode(page, authenticatorCode(key));
  await page.getByRole('button', { name: t('auth:twoStep.confirm') }).click();

  // 4. The recovery codes, shown once.
  await expect(step(4, 'codes')).toBeVisible();
  await expect(page.getByRole('list').getByRole('listitem')).toHaveCount(10);
  await page.getByText(t('auth:recovery.saved')).click();
  await page.getByRole('button', { name: t('auth:recovery.continue') }).click();

  // 5. This PC, enrolled as the POS through the real protocol.
  await expect(step(5, 'device')).toBeVisible();
  await page
    .getByLabel(t('firstRun:device.code'), { exact: true })
    .fill(`SERVER-${lang.toUpperCase()}`);
  await page.getByRole('button', { name: t('firstRun:device.enroll') }).click();
  await expect(page.getByRole('heading', { name: t('firstRun:finish.title') })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: t('firstRun:finish.button') }).click();
  await expect(page.getByRole('heading', { name: t('firstRun:done.title') })).toBeVisible();
  await snap(page, '99-setup-done');

  // The normal sign-in on this PC, now the POS; the wizard never comes back.
  await page.getByRole('button', { name: t('firstRun:done.button') }).click();
  await expect(page.getByRole('heading', { name: t('auth:signIn.title') })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(`SERVER-${lang.toUpperCase()}`)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: t('auth:signIn.title') })).toBeVisible({
    timeout: 30_000,
  });
});
