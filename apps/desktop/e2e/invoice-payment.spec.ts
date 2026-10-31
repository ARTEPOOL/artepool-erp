/**
 * The owner's test of 2026-10-29 (decision 0113) against the real server, in Arabic and English:
 * an unpaid A4 invoice for the cash customer (the owner may leave it unpaid, 0046), then "Receive
 * payment" from the invoice. The receipt opens set on that invoice with what is due, says it will
 * settle it, and does: the invoice reads paid, its history shows the receipt and its method, and
 * no advance payment invoice appears.
 */
import { control, expect, signInAsOwner, snap, test } from './fixtures';
import type { Page } from '@playwright/test';

test.setTimeout(180_000);

const nav = (page: Page) => page.getByRole('complementary');

test('paying an invoice from its page settles that invoice; no advance payment invoice', async ({
  page,
  open,
  t,
  lang,
}) => {
  const n = `${Date.now() % 100000}`.padStart(5, '0');
  const code = `PY-${lang}-${n}`;
  await control.addPosItem({
    code,
    nameAr: `فلتر ${n}`,
    nameEn: `Filter ${n}`,
    barcode: `628${n}0001`,
    price4dp: '1000000', // 100.00, VAT included
    quantityMilli: '5000',
  });
  await open('office');
  await signInAsOwner(page, t);

  // An unpaid invoice for the cash customer (the owner may leave it unpaid, 0046).
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
  await page
    .getByRole('dialog')
    .getByRole('button', { name: t('invoices:issue.confirm'), exact: true })
    .click();
  const heading = page.getByRole('heading', { level: 1, name: /INV-\d+/ });
  await expect(heading).toBeVisible();
  const number = ((await heading.textContent()) ?? '').match(/INV-\d+/)![0];
  await expect(page.getByText(t('sales:settlement.open')).first()).toBeVisible();

  // "Receive payment" from the invoice: set on it, 100.00, and it says so before saving.
  await page.getByRole('button', { name: t('invoices:view.receive') }).click();
  await expect(page.getByLabel(t('receipts:receive.amount'))).toHaveValue('100.00');
  const effects = page.getByTestId('receive-effects');
  await expect(effects).toContainText(number);
  await expect(effects.getByRole('listitem')).toHaveCount(1);
  await effects.scrollIntoViewIfNeeded();
  await snap(page, '78-receive-from-invoice');
  await page
    .getByRole('button', { name: t('receipts:receive.submit', { amount: '100.00' }) })
    .click();
  // No advance payment invoice: no confirmation, straight to the receipt.
  await expect(page.getByRole('heading', { level: 1, name: /RCT-\d+/ })).toBeVisible();
  await expect(page.getByTestId('receive-confirm')).toHaveCount(0);

  // The invoice reads paid in the list (Invoices tab), and its history shows the receipt.
  await nav(page)
    .getByRole('link', { name: t('settings:nav.invoices') })
    .click();
  const row = page.getByRole('row', { name: new RegExp(number) }).first();
  await expect(row).toContainText(t('sales:settlement.settled'));
  await expect(row).not.toContainText(t('invoices:state.advance'));
  await snap(page, '79-invoice-paid-in-list');
  await row.click();
  const history = page.getByRole('list', { name: t('invoices:view.timeline') });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(history).toContainText(/RCT-\d+/);
  await history.scrollIntoViewIfNeeded();
  await snap(page, '80-invoice-history');
});
