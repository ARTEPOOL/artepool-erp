/**
 * A barcode scanner in the items search (decision 0096 follow-up): a scanner types like a keyboard,
 * a few milliseconds per key, then Enter. With Windows on the Arabic keyboard the letters arrive as
 * Arabic ones; the code must come back in Latin letters, and each new scan must replace the last one
 * (the same code twice changes nothing). A person typing a name is left alone.
 */
import type { Locator } from '@playwright/test';
import { expect, signInAsOwner, test } from './fixtures';

/**
 * Types like a device: one key event and one input event per key, `gapMs` apart (0 = as fast as a
 * scanner), then Enter.
 */
async function typeLikeDevice(field: Locator, keys: string[], gapMs: number, enter = true) {
  await field.evaluate(
    async (input: HTMLInputElement, { keys, gapMs, enter }) => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
      // The field's own value setter, so React sees the change as typing.
      const setValue = (value: string) => descriptor.set!.call(input, value);
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      input.focus();
      for (const key of keys) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        // A key replaces the selected text, as in any text field.
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        setValue(input.value.slice(0, start) + key + input.value.slice(end));
        input.setSelectionRange(start + key.length, start + key.length);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (gapMs > 0) await sleep(gapMs);
      }
      if (enter) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
    },
    { keys, gapMs, enter },
  );
}

test('scans replace each other and come back in Latin letters', async ({ page, open, t }) => {
  await open('office');
  await signInAsOwner(page, t);
  await page.getByRole('link', { name: t('settings:nav.items') }).click();
  const search = page.getByRole('searchbox', { name: t('items:search') });

  // TEST-1234 scanned with the Arabic keyboard on: T = لإ, E = ُ, S = ٍ (Shift).
  await typeLikeDevice(search, ['لإ', '\u064F', '\u064D', 'لإ', '-', '1', '2', '3', '4'], 0);
  await expect(search).toHaveValue('TEST-1234');

  // A second scan replaces the first one; the same code again changes nothing.
  await page.waitForTimeout(500);
  await typeLikeDevice(search, [...'6291041500213'], 0);
  await expect(search).toHaveValue('6291041500213');
  await page.waitForTimeout(500);
  await typeLikeDevice(search, [...'6291041500213'], 0);
  await expect(search).toHaveValue('6291041500213');

  // A person typing an Arabic name afterwards: it replaces the scan and stays Arabic.
  await page.waitForTimeout(500);
  await typeLikeDevice(search, [...'كلور'], 120, false);
  await expect(search).toHaveValue('كلور');
});
