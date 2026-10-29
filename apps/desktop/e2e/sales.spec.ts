/**
 * Sales (M4) against the real server: the worked example of decision 0013. A pool is quoted at
 * 100,000 + 5% VAT; the customer pays 31,500 and then 42,000 on the quotation, and each payment
 * gets its own payment tax invoice (VAT 1,500 and 2,000); the quotation becomes the final
 * invoice, which deducts both payments and leaves 31,500 due (VAT 1,500 on it).
 */
import { expect, signInAsOwner, snap, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

/** Different for each project and run, in digits only. */
const runDigits = () => `${Date.now() % 1_000_000}`.padStart(6, '0');

/** A text as an exact part of a pattern (labels may have brackets). */
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** The side menu (pages may link to the same names). */
const nav = (page: Page) => page.getByRole('complementary');

type T = (key: string, values?: Record<string, string | number>) => string;

/** React Aria switches hide their input under the label: press the label (if it is on). */
async function turnOff(toggle: Locator) {
  if (await toggle.isChecked()) await toggle.locator('xpath=ancestor::label[1]').click();
  await expect(toggle).not.toBeChecked();
}

async function newPoolService(page: Page, t: T, lang: string, n: string) {
  await nav(page)
    .getByRole('link', { name: t('settings:nav.items') })
    .click();
  await page.getByRole('button', { name: t('items:newItem') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: t('items:types.service'), exact: true }).click();
  await dialog
    .getByLabel(t('items:fields.category'), { exact: true })
    .selectOption({ label: lang === 'en' ? 'Services' : 'خدمات' });
  await dialog
    .getByLabel(t('items:fields.businessLine'), { exact: true })
    .selectOption({ label: lang === 'en' ? 'Pool construction' : 'إنشاء المسابح' });
  await dialog.getByLabel(t('items:fields.nameAr'), { exact: true }).fill(`إنشاء مسبح ${n}`);
  await dialog.getByLabel(t('items:fields.nameEn'), { exact: true }).fill(`Pool construction ${n}`);
  await dialog.getByLabel(t('items:fields.price'), { exact: true }).fill('100000');
  await turnOff(dialog.getByRole('switch', { name: t('items:fields.includesVat') }));
  const code = await dialog.getByLabel(t('items:fields.code'), { exact: true }).inputValue();
  await dialog.getByRole('button', { name: t('items:dialog.save') }).click();
  await expect(dialog).toHaveCount(0);
  return code;
}

async function newCustomer(page: Page, t: T, n: string) {
  const name = `فيلا الجيمي ${n}`;
  await nav(page)
    .getByRole('link', { name: t('settings:nav.customers') })
    .click();
  await page.getByRole('button', { name: t('parties:customers.new') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: t('parties:types.individual') }).click();
  await dialog.getByLabel(t('parties:form.name'), { exact: true }).fill(name);
  await dialog.getByLabel(t('parties:form.phone'), { exact: true }).fill(`050${n}2`);
  // An A4 invoice is a full tax invoice: the customer's address is printed (decision 0071).
  await dialog.getByLabel(t('parties:form.address'), { exact: true }).fill('Al Jimi, Al Ain');
  await dialog.getByRole('button', { name: t('parties:form.save') }).click();
  await expect(dialog).toHaveCount(0);
  return name;
}

async function chooseCustomer(page: Page, t: T, name: string) {
  await page.getByLabel(t('sales:customerPicker.search')).fill(name);
  await page
    .getByRole('list', { name: t('sales:customerPicker.results') })
    .getByRole('button', { name: new RegExp(name) })
    .click();
}

async function confirmStep(page: Page, t: T, action: string) {
  await page.getByRole('button', { name: t(`quotations:actions.${action}`), exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: t(`quotations:confirm.${action}.confirm`) }).click();
  await expect(dialog).toHaveCount(0);
}

/** Receives an advance on the accepted quotation; returns the payment invoice number. */
async function receiveAdvance(page: Page, t: T, customer: string, amount: string, vat: string) {
  await nav(page)
    .getByRole('link', { name: t('settings:nav.receipts') })
    .click();
  await page.getByRole('button', { name: t('receipts:receive.button') }).click();
  await chooseCustomer(page, t, customer);
  // Cash: the first office method.
  await page.getByLabel(t('sales:fields.method'), { exact: true }).selectOption({ index: 0 });
  await page.getByLabel(literal(t('receipts:receive.amount'))).fill(amount);
  await page.getByRole('button', { name: t('receipts:receive.modes.advance') }).click();
  await page
    .getByLabel(t('receipts:receive.quotation'), { exact: true })
    .selectOption({ index: 1 });
  // The VAT inside the advance: amount × 5/105.
  await expect(page.getByText(vat).first()).toBeVisible();
  await page
    .getByRole('button', { name: new RegExp(t('receipts:receive.submit', { amount: '.*' })) })
    .click();
  // An advance payment invoice is confirmed first (decision 0113).
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByTestId('receive-confirm')).toContainText(vat);
  await confirm.getByRole('button', { name: t('receipts:receive.confirm.yes') }).click();
  // The receipt opens with a link to the payment invoice made for the advance.
  await expect(page.getByRole('heading', { level: 1, name: /RCT-\d+/ })).toBeVisible();
  const invoice = page
    .getByRole('main')
    .getByRole('link', { name: /INV-\d+/ })
    .first();
  return (await invoice.innerText()).trim();
}

test('decision 0013: quotation, two advances with their VAT, the final invoice deducts both', async ({
  page,
  open,
  t,
  lang,
}) => {
  test.setTimeout(180_000);
  const n = runDigits();
  await open('office');
  await signInAsOwner(page, t);
  const code = await newPoolService(page, t, lang, n);
  const customer = await newCustomer(page, t, n);

  // The quotation: 100,000 + 5% VAT = 105,000; sent, then accepted.
  await nav(page)
    .getByRole('link', { name: t('settings:nav.quotations') })
    .click();
  await page.getByRole('button', { name: t('quotations:list.new') }).click();
  await chooseCustomer(page, t, customer);
  await page.getByLabel(t('sales:lines.search')).fill(code);
  await page
    .getByRole('list', { name: t('sales:lines.results') })
    .getByRole('button', { name: new RegExp(code) })
    .click();
  await expect(page.getByText('105,000.00').first()).toBeVisible();
  await snap(page, '70-quotation-new');
  await page.getByRole('button', { name: t('quotations:editor.create') }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Q-\d+/ })).toBeVisible();
  await confirmStep(page, t, 'send');
  await confirmStep(page, t, 'accept');
  const quotation = (
    await page.getByRole('heading', { level: 1, name: /Q-\d+/ }).innerText()
  ).match(/Q-\d+/)![0];
  await snap(page, '71-quotation-accepted');

  // Two payments on the quotation, each with its payment tax invoice.
  const first = await receiveAdvance(page, t, customer, '31500', '1,500.00');
  await snap(page, '72-receipt-advance');
  const second = await receiveAdvance(page, t, customer, '42000', '2,000.00');
  expect(second).not.toBe(first);

  // The final invoice from the quotation, deducting both payments.
  // (The app keeps its place in memory only: go back through the menu.)
  await nav(page)
    .getByRole('link', { name: t('settings:nav.quotations') })
    .click();
  await page.getByRole('row', { name: new RegExp(quotation) }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Q-\d+/ })).toBeVisible();
  await confirmStep(page, t, 'convert');
  await expect(
    page.getByRole('heading', { level: 1, name: t('invoices:form.draftTitle') }),
  ).toBeVisible();
  for (const number of [first, second]) {
    // React Aria checkboxes hide their input under the label: press the label.
    const box = page.getByRole('checkbox', {
      name: t('invoices:form.advances.deduct', { number }),
    });
    await box.locator('xpath=ancestor::label[1]').click();
    await expect(box).toBeChecked();
  }
  await expect(page.getByText('31,500.00').first()).toBeVisible();
  await page.getByRole('button', { name: t('invoices:form.save') }).click();
  await expect(page.getByText(t('invoices:form.saved'))).toBeVisible();
  await snap(page, '73-invoice-draft-deductions');
  await page.getByRole('button', { name: t('invoices:form.issue') }).click();
  const issue = page.getByRole('dialog');
  await issue.getByRole('button', { name: t('invoices:issue.confirm'), exact: true }).click();
  await expect(issue).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: /INV-\d+/ })).toBeVisible();

  // 105,000 − 73,500 already paid = 31,500 due, of which VAT 1,500.
  await expect(page.getByText(t('invoices:view.beforeDeductions'))).toBeVisible();
  await expect(page.getByText('105,000.00').first()).toBeVisible();
  await expect(page.getByText('73,500.00').first()).toBeVisible();
  await expect(page.getByText('31,500.00').first()).toBeVisible();
  await expect(page.getByText(first).first()).toBeVisible();
  await expect(page.getByText(second).first()).toBeVisible();
  await snap(page, '74-invoice-final');

  // Print: the server's PDF opens in a hidden frame for the print dialog, which the page's
  // security policy allows (blob: frames only) — nothing is blocked.
  const blocked: string[] = [];
  page.on('console', (m) => {
    if (m.text().includes('Content Security Policy')) blocked.push(m.text());
  });
  await page.evaluate(() => {
    // The real dialog cannot open in a hidden browser; count the requests instead.
    (window as unknown as { printed: number }).printed = 0;
  });
  await page.getByRole('button', { name: t('sales:print.print'), exact: true }).click();
  await expect(page.locator('iframe[src^="blob:"]')).toHaveCount(1);
  expect(blocked).toEqual([]);
});
