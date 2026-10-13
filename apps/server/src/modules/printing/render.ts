/**
 * HTML → A4 PDF with headless Chromium (architecture §7: one renderer for the preview and the
 * print, correct Arabic shaping). The browser starts on first use and is reused; it never loads
 * anything from the network (the HTML embeds its fonts and logo).
 * Which browser: ARTEPOOL_CHROMIUM (the pinned one on the server PC) if set; otherwise the one
 * `playwright-core install chromium-headless-shell` placed; otherwise Microsoft Edge, which every
 * Windows PC has — so printing works on a development PC without any extra step.
 */
import { chromium, type Browser } from 'playwright-core';
import { ruleError } from '../../platform/errors/app-error';

let browser: Promise<Browser> | null = null;

async function firstThatStarts(): Promise<Browser> {
  const pinned = process.env.ARTEPOOL_CHROMIUM;
  if (pinned) return chromium.launch({ headless: true, executablePath: pinned });
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    return chromium.launch({ headless: true, channel: 'msedge' });
  }
}

function launch(): Promise<Browser> {
  browser ??= firstThatStarts().catch((error: unknown) => {
    browser = null;
    const refused = ruleError('PRINTER_UNAVAILABLE', 'The PDF renderer could not start');
    refused.cause = error;
    throw refused;
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
