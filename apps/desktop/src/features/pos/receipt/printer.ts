/**
 * The receipt printer of this PC (decisions 0008, 0055, 0070), chosen in Settings → Devices and
 * kept on this PC only. Two ways to print, both silent:
 * - `escpos` (thermal receipt printer): the job goes RAW as ESC/POS bytes; the drawer, wired to
 *   the printer, opens with the kick inside the job;
 * - `driver` (any printer: A4, or a thermal printer whose driver does not pass ESC/POS through):
 *   the receipt image goes through the printer's own Windows driver, at its real size. There is
 *   no drawer kick this way (ESC/POS bytes would print as rubbish on such a printer).
 * In a browser (development) nothing reaches a printer: the caller shows the receipt image.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { i18n as I18n } from 'i18next';
import type { ReceiptData } from '@artepool/shared/contracts';
import { drawerKickJob, receiptJob, toBase64 } from './escpos';
import { receiptModel, type ReceiptLanguage } from './layout';
import { renderReceipt, type ReceiptImage } from './render';

const PRINTER_KEY = 'artepool.receiptPrinter';
const MODE_KEY = 'artepool.receiptPrinterMode';

export type PrinterMode = 'escpos' | 'driver';

export function savedMode(): PrinterMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'driver' ? 'driver' : 'escpos';
  } catch {
    return 'escpos';
  }
}

export function saveMode(mode: PrinterMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not kept: the default (thermal) is used next time.
  }
}

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
  | {
      printed: false;
      reason: 'browser' | 'no_printer' | 'failed' | 'no_drawer';
      message?: string;
    };

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

/** Prints a drawn receipt the way this PC's printer takes it; the drawer only on ESC/POS. */
export async function printImage(
  image: ReceiptImage,
  documentName: string,
  kickDrawer = false,
): Promise<PrintOutcome> {
  if (savedMode() === 'escpos') return sendJob(receiptJob({ ...image, kickDrawer }), documentName);
  if (!isTauri()) return { printed: false, reason: 'browser' };
  const printer = savedPrinter();
  if (!printer) return { printed: false, reason: 'no_printer' };
  try {
    await invoke('printer_print_image', {
      printer,
      documentName,
      widthDots: image.canvas.width,
      height: image.height,
      bitsBase64: toBase64(image.bits),
    });
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
  const outcome = await printImage(image, data.document.docNumber ?? 'receipt', opts.kickDrawer);
  return { outcome, imageUrl: image.canvas.toDataURL('image/png') };
}

/** Prints an image already drawn (the print designer's test receipt); never opens the drawer. */
export function printReceiptImage(image: ReceiptImage | null): Promise<PrintOutcome> {
  if (!image) return Promise.resolve({ printed: false, reason: 'failed' });
  return printImage(image, 'test-receipt');
}

/** Opens the drawer without printing (No Sale, cash movements). */
export function kickDrawer(): Promise<PrintOutcome> {
  if (savedMode() === 'driver') return Promise.resolve({ printed: false, reason: 'no_drawer' });
  return sendJob(drawerKickJob(), 'drawer');
}
