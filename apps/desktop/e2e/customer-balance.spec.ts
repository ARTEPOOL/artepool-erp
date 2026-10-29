/**
 * The customer's balance everywhere (decision 0114) against the real server, in Arabic and
 * English. A credit customer (limit 1,000.00) owes 300.00 from an opening balance due yesterday:
 * the owner sees it orange with its amounts in the customers list, on the customer page with the
 * open invoices and their age, under the customer on a new A4 invoice, and in the Print designer's
 * "Account summary" choice. A cashier sees the colour and the words, never an amount (the same
 * banner as on the POS).
 */
import { control, expect, signInAsOwner, snap, test, unique } from './fixtures';
import type { Page } from '@playwright/test';

test.setTimeout(180_000);

const nav = (page: Page) => page.getByRole('complementary');

async function creditCustomer(lang: string, suffix: string) {
  const n = `${Date.now() % 100000}`.padStart(5, '0');
  const name = lang === 'ar' ? `مقاولات الواحة ${n}` : `Oasis Contracting ${n}`;
  await control.addCreditCustomer({
    name,
    phone: `056${n}${suffix}`,
    creditLimitFils: '100000',
    overdueFils: '30000',
  });
  return { name, n };
}

test('the owner: the list, the customer page, the invoice banner and the print choice', async ({
  page,
  open,
  t,
  lang,
}) => {
  const { name } = await creditCustomer(lang, lang === 'ar' ? '11' : '21');
  await open('office');
  await signInAsOwner(page, t);

  // The customers list: the Outstanding column, orange (overdue), and the overdue filter.
  await nav(page)
    .getByRole('link', { name: t('settings:nav.customers') })
    .click();
  await page.getByLabel(t('parties:customers.search')).fill(name);
  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row.locator('[data-status="overdue"]')).toHaveText('300.00');
  await page
    .getByRole('group', { name: t('parties:customers.filter') })
    .getByRole('button', { name: t('parties:customers.filters.overdue') })
    .click();
  await expect(row).toBeVisible();

  // The customer page: the banner, net position, the opening balance one day late.
  await row.click();
  const account = page.getByRole('table', { name: t('receipts:account.openTitle') });
  await expect(account).toContainText(t('receipts:account.openingBalance'));
  await expect(account).toContainText('300.00');
  await expect(page.getByText(t('receipts:account.netPosition'))).toBeVisible();
  await expect(page.getByRole('status', { name: t('sales:balance.label') }).first()).toContainText(
    t('sales:balance.status.overdue'),
  );
  await account.scrollIntoViewIfNeeded();
  await snap(page, '80-customer-page-balance');

  // A new A4 invoice: the banner under the customer with the amounts.
  await nav(page)
    .getByRole('link', { name: t('settings:nav.invoices') })
    .click();
  await page.getByRole('button', { name: t('invoices:list.new') }).click();
  // A new invoice starts with the cash customer (no banner): change it.
  await expect(page.getByText(t('sales:customerPicker.walkIn'))).toBeVisible();
  await expect(page.getByRole('status', { name: t('sales:balance.label') })).toHaveCount(0);
  await page.getByRole('button', { name: t('sales:customerPicker.change') }).click();
  await page.getByLabel(t('sales:customerPicker.search')).fill(name);
  await page
    .getByRole('list', { name: t('sales:customerPicker.results') })
    .getByRole('button', { name: new RegExp(name) })
    .click();
  const banner = page.getByRole('status', { name: t('sales:balance.label') });
  await expect(banner).toHaveAttribute('data-status', 'overdue');
  await expect(banner).toContainText(t('sales:balance.status.overdue'));
  await expect(banner).toContainText(t('sales:balance.outstanding', { amount: '300.00' }));
  await expect(banner).toContainText(t('sales:balance.overdue', { amount: '300.00' }));
  await expect(banner).toContainText(t('sales:balance.limit', { amount: '1,000.00' }));
  await expect(banner).toContainText(t('sales:balance.available', { amount: '700.00' }));
  await snap(page, '81-invoice-balance-banner');

  // The Print designer: the account summary is on for credit customers by default.
  await nav(page)
    .getByRole('link', { name: t('settings:nav.settings') })
    .click();
  await page.getByRole('link', { name: t('settings:hub.print') }).click();
  const choice = page.getByRole('group', { name: t('settings:print.balanceBlock') });
  await expect(
    choice.getByRole('button', { name: t('settings:print.balanceBlocks.credit_customers') }),
  ).toHaveAttribute('aria-pressed', 'true');
  await choice.scrollIntoViewIfNeeded();
  await snap(page, '82-print-designer-balance-block');
});

test('the cashier: the colour and the words, never an amount', async ({ page, open, t, lang }) => {
  const { name } = await creditCustomer(lang, lang === 'ar' ? '12' : '22');
  const username = unique('cashier');
  await control.addUser({
    username,
    password: 'blue-pool-water-7',
    roles: ['cashier'],
    displayNameAr: 'كاشير الرصيد',
    displayNameEn: 'Balance cashier',
  });
  await open('office');
  await page.getByLabel(t('auth:signIn.username'), { exact: true }).fill(username);
  await page.getByLabel(t('auth:signIn.password'), { exact: true }).fill('blue-pool-water-7');
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
  await expect(page.getByRole('button', { name: t('settings:user.menu') })).toBeVisible();

  // Receive payment: the same banner as the POS and the A4 invoice, without the amounts.
  await nav(page)
    .getByRole('link', { name: t('settings:nav.receipts') })
    .click();
  await page.getByRole('button', { name: t('receipts:receive.button') }).click();
  await page.getByLabel(t('sales:customerPicker.search')).fill(name);
  await page
    .getByRole('list', { name: t('sales:customerPicker.results') })
    .getByRole('button', { name: new RegExp(name) })
    .click();
  const banner = page.getByRole('status', { name: t('sales:balance.label') });
  await expect(banner).toHaveAttribute('data-status', 'overdue');
  await expect(banner).toHaveText(t('sales:balance.status.overdue'));
  await expect(banner).not.toContainText('300');
  await snap(page, '83-receipt-balance-cashier');
});
