/**
 * HTML → A4 PDF with headless Chromium (architecture §7: one renderer for the preview and the
 * print, correct Arabic shaping). The browser starts on first use and is reused; it never loads
 * anything from the network (the HTML embeds its fonts and logo).
 * Which browser: ARTEPOOL_CHROMIUM (the pinned one on the server PC) if set; otherwise the one
 * `playwright-core install chromium-headless-shell` placed; otherwise Microsoft Edge, which every
 * Windows PC has — so printing works on a development PC without any extra step.
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { childEnv } from '@artepool/node-kit';
import { ruleError } from '../../platform/errors/app-error';

let browser: Promise<Browser> | null = null;

async function firstThatStarts(): Promise<Browser> {
  // The browser never needs the database passwords the server was started with.
  const options = { headless: true, env: childEnv({}) };
  const pinned = process.env.ARTEPOOL_CHROMIUM;
  if (pinned) return chromium.launch({ ...options, executablePath: pinned });
  try {
    return await chromium.launch(options);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    return chromium.launch({ ...options, channel: 'msedge' });
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

/**
 * Every font the page declares, loaded before printing. The fonts are embedded as data: URLs and
 * decode in the background after "load"; text whose font is still loading is drawn invisible, so
 * printing at once could give a page with only its lines and boxes (a blank credit note in the
 * accountant pack, 5 of 20 prints in a test). A font that cannot load stops the print instead.
 * Runs in Playwright's own isolated world: the page's scripts stay disabled.
 */
async function fontsReady(page: Page): Promise<void> {
  // As text: it runs in the browser, which the server's TypeScript settings do not describe.
  const failed = await page.evaluate<string[]>(`(async () => {
    const faces = [...document.fonts];
    await Promise.allSettled(faces.map((face) => face.load()));
    await document.fonts.ready;
    return faces.filter((face) => face.status !== 'loaded').map((face) => face.family);
  })()`);
  if (failed.length > 0) {
    throw ruleError('PRINTER_UNAVAILABLE', `Fonts could not load: ${failed.join(', ')}`);
  }
}

export async function renderPdf(html: string): Promise<Buffer> {
  const context = await (await launch()).newContext({ javaScriptEnabled: false, offline: true });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await fontsReady(page);
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
