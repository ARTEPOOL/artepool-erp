/**
 * Editing an issued A4 invoice (decision 0072) against the real server, in Arabic and English:
 * the owner issues a paid invoice, then edits it. A credit note cancels all of it and refunds the
 * cash, the invoice is marked as replaced, and a new draft copied from it opens for changes.
 */
import { control, expect, signInAsOwner, snap, test } from './fixtures';
import type { Page } from '@playwright/test';

test.setTimeout(180_000);

const nav = (page: Page) => page.getByRole('complementary');

test('the owner edits an issued invoice: cancelled by a credit note, a new draft opens', async ({
  page,
  open,
  t,
  lang,
}) => {
  const n = `${Date.now() % 100000}`.padStart(5, '0');
  const code = `CX-${lang}-${n}`;
  await control.addPosItem({
    code,
    nameAr: `مضخة ${n}`,
    nameEn: `Pump ${n}`,
    barcode: `629${n}0001`,
    price4dp: '1050000',
    quantityMilli: '5000',
  });
  await open('office');
  await signInAsOwner(page, t);

  // A new invoice for the cash customer: nothing to type (a simplified invoice, 0071).
  await nav(page)
    .getByRole('link', { name: t('settings:nav.invoices') })
    .click();
  await page.getByRole('button', { name: t('invoices:list.new') }).click();
  await page.getByLabel(t('sales:lines.search')).fill(code);
  await page
    .getByRole('list', { name: t('sales:lines.results') })
    .getByRole('button', { name: new RegExp(code) })
    .click();
  await page.getByRole('button', { name: t('invoices:form.save') }).click();
  await expect(page.getByText(t('invoices:form.saved'))).toBeVisible();
  await page.getByRole('button', { name: t('invoices:form.issue') }).click();
  const issue = page.getByRole('dialog');
  await issue.getByRole('button', { name: t('invoices:pay.add') }).click();
  await issue.getByLabel(t('sales:fields.method')).selectOption({ index: 1 });
  await issue.getByLabel(t('sales:fields.amount')).fill('105');
  await issue.getByRole('button', { name: t('invoices:issue.confirm'), exact: true }).click();
  await expect(issue).toHaveCount(0);
  const heading = page.getByRole('heading', { level: 1, name: /INV-\d+/ });
  await expect(heading).toBeVisible();
  const number = ((await heading.textContent()) ?? '').match(/INV-\d+/)![0];

  // Edit: a reason, the paid 105.00 refunded in cash, then the copy opens as a draft.
  await page.getByRole('button', { name: t('invoices:cancel.editButton') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(t('invoices:cancel.reason')).fill('Wrong customer');
  await expect(dialog.getByLabel(t('sales:fields.amount'))).toHaveValue('105.00');
  await snap(page, '75-invoice-edit-dialog');
  await dialog.getByRole('button', { name: t('invoices:cancel.editConfirm') }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('heading', { level: 1, name: t('invoices:form.draftTitle') }),
  ).toBeVisible();
  await expect(page.getByText(new RegExp(code)).first()).toBeVisible();
  await snap(page, '76-invoice-edit-draft');

  // The original stays, marked as replaced by the credit note.
  await nav(page)
    .getByRole('link', { name: t('settings:nav.invoices') })
    .click();
  await page
    .getByRole('row', { name: new RegExp(number) })
    .first()
    .click();
  await expect(page.getByText(/CN-\d+/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: t('invoices:cancel.editButton') })).toHaveCount(0);
});
