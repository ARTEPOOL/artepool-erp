/**
 * HTML → A4 PDF with headless Chromium (architecture §7: one renderer for the preview and the
 * print, correct Arabic shaping). The browser starts on first use and is reused; it never loads
 * anything from the network (the HTML embeds its fonts and logo).
 * ARTEPOOL_CHROMIUM names the pinned browser on the server PC; in development the browser that
 * `playwright install chromium` placed is used.
 */
import { chromium, type Browser } from 'playwright-core';

let browser: Promise<Browser> | null = null;

function launch(): Promise<Browser> {
  browser ??= chromium
    .launch({
      headless: true,
      ...(process.env.ARTEPOOL_CHROMIUM ? { executablePath: process.env.ARTEPOOL_CHROMIUM } : {}),
    })
    .catch((error: unknown) => {
      browser = null;
      throw error;
    });
  return browser;
}

export async function renderPdf(html: string): Promise<Buffer> {
  const context = await (await launch()).newContext({ javaScriptEnabled: false, offline: true });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await context.close();
  }
}

export async function closeRenderer(): Promise<void> {
  if (!browser) return;
  const b = await browser.catch(() => null);
  browser = null;
  await b?.close();
}
