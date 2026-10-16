/**
 * The receipt printer of this PC (decisions 0008, 0055). The Windows app sends the job RAW to the
 * printer chosen in Settings → Devices, silently; the drawer opens with the kick inside the job.
 * The choice is kept on this PC only. In a browser (development) nothing reaches a printer: the
 * caller shows the receipt image instead.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { i18n as I18n } from 'i18next';
import type { ReceiptData } from '@artepool/shared/contracts';
import { drawerKickJob, receiptJob, toBase64 } from './escpos';
import { receiptModel, type ReceiptLanguage } from './layout';
import { renderReceipt } from './render';

const PRINTER_KEY = 'artepool.receiptPrinter';

export function savedPrinter(): string | null {
  try {
    return localStorage.getItem(PRINTER_KEY);
  } catch {
    return null;
  }
}

export function savePrinter(name: string | null): void {
  try {
    if (name) localStorage.setItem(PRINTER_KEY, name);
    else localStorage.removeItem(PRINTER_KEY);
  } catch {
    // Not kept: the person chooses again next time.
  }
}

export const canPrintSilently = (): boolean => isTauri();

export async function listPrinters(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>('printer_list');
}

export type PrintOutcome =
  | { printed: true }
  | { printed: false; reason: 'browser' | 'no_printer' | 'failed'; message?: string };

export async function sendJob(bytes: Uint8Array, documentName: string): Promise<PrintOutcome> {
  if (!isTauri()) return { printed: false, reason: 'browser' };
  const printer = savedPrinter();
  if (!printer) return { printed: false, reason: 'no_printer' };
  try {
    await invoke('printer_print', { printer, documentName, dataBase64: toBase64(bytes) });
    return { printed: true };
  } catch (error) {
    return { printed: false, reason: 'failed', message: String(error) };
  }
}

/**
 * Draws and prints a receipt with the template version stored on its document (decision 0064):
 * its language, paper width and fields. Returns the outcome and the image (for a preview).
 */
export async function printReceipt(
  data: ReceiptData,
  opts: {
    /** Only for receipts from before decision 0064, which carry no template. */
    language?: ReceiptLanguage;
    i18n: I18n;
    kickDrawer: boolean;
    logo?: HTMLImageElement | null;
  },
): Promise<{ outcome: PrintOutcome; imageUrl: string }> {
  const model = receiptModel(data, data.template?.language ?? opts.language ?? 'both', {
    ar: opts.i18n.getFixedT('ar', 'pos'),
    en: opts.i18n.getFixedT('en', 'pos'),
  });
  const image = renderReceipt(model, undefined, opts.logo ?? null);
  const job = receiptJob({ ...image, kickDrawer: opts.kickDrawer });
  const outcome = await sendJob(job, data.document.docNumber ?? 'receipt');
  return { outcome, imageUrl: image.canvas.toDataURL('image/png') };
}

/** Opens the drawer without printing (No Sale, cash movements). */
export function kickDrawer(): Promise<PrintOutcome> {
  return sendJob(drawerKickJob(), 'drawer');
}
