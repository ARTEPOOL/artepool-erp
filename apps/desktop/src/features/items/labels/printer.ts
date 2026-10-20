/**
 * The label printer of this PC (decision 0096), kept on the server (auth.devices.printer_config) and
 * set by the owner in Settings → Devices. Labels are drawn here at the printer's dots and sent
 * silently, as TSPL straight to the printer (Rust: `printer_print`, decision 0100) or through its
 * Windows driver at the label's exact size (Rust: `printer_print_label`). In a
 * browser (development), or with no printer chosen, the caller falls back to the print dialog.
 */
import { useQuery } from '@tanstack/react-query';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  DEFAULT_LABEL_PRINTER,
  type LabelPrinterConfig,
  type LabelSizeItem,
  type ThisDeviceResponse,
} from '@artepool/shared/contracts';
import { useApi } from '../../../api/hooks';
import { toBase64 } from '../../pos/receipt/escpos';
import type { PrintOutcome } from '../../pos/receipt/printer';
import type { LabelImage } from './render';
import { tsplLabelJob } from './tspl';

export const THIS_DEVICE_KEY = ['devices', 'me'] as const;

/** This PC's label printer (the defaults until the owner sets one). */
export function useLabelPrinter() {
  const api = useApi();
  return useQuery({
    queryKey: THIS_DEVICE_KEY,
    queryFn: () => api.get<ThisDeviceResponse>('/api/v1/devices/me'),
    select: (r): LabelPrinterConfig => r.labelPrinter ?? DEFAULT_LABEL_PRINTER,
  });
}

/** True when labels can go straight to the label printer (the Windows app, a printer chosen). */
export const canPrintLabelsSilently = (config: LabelPrinterConfig | undefined): boolean =>
  isTauri() && Boolean(config?.printer);

/** What happened to a label print; `failed_direct`: the printer did not take the TSPL job. */
export type LabelPrintOutcome =
  PrintOutcome | { printed: false; reason: 'failed_direct'; message?: string };

/**
 * Sends drawn labels to this PC's label printer: `copies` labels of the label's exact size, either
 * as TSPL bytes straight to the printer (decision 0100) or through its Windows driver. A direct
 * print that fails is not sent again through the driver by itself: the printer may have printed
 * part of it already. The message says to try again or to switch back to the driver.
 */
export async function printLabels(
  image: LabelImage,
  size: Pick<LabelSizeItem, 'widthMm' | 'heightMm'>,
  config: LabelPrinterConfig,
  copies: number,
  documentName: string,
): Promise<LabelPrintOutcome> {
  if (!isTauri()) return { printed: false, reason: 'browser' };
  if (!config.printer) return { printed: false, reason: 'no_printer' };
  if (config.mode === 'tspl') {
    try {
      await invoke('printer_print', {
        printer: config.printer,
        documentName,
        dataBase64: toBase64(tsplLabelJob(image, size, config, copies)),
      });
      return { printed: true };
    } catch (error) {
      return { printed: false, reason: 'failed_direct', message: String(error) };
    }
  }
  try {
    await invoke('printer_print_label', {
      printer: config.printer,
      documentName,
      widthDots: image.widthDots,
      height: image.height,
      bitsBase64: toBase64(image.bits),
      dpi: config.dpi,
      widthMm10: Math.round(size.widthMm * 10),
      heightMm10: Math.round(size.heightMm * 10),
      copies,
    });
    return { printed: true };
  } catch (error) {
    return { printed: false, reason: 'failed', message: String(error) };
  }
}
