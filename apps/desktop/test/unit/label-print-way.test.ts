// @vitest-environment node
/**
 * The way labels reach the label printer (decisions 0096, 0100): "Direct (TSPL)" sends the TSPL job
 * RAW (`printer_print`); "Windows driver" sends the image to the driver (`printer_print_label`). A
 * direct print that fails is reported and never sent again through the driver by itself (the printer
 * may have printed part of it: no double labels).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LABEL_PRINTER } from '@artepool/shared/contracts';

/** The Windows side, faked: the commands it was given; `fail` makes it refuse them. */
const fake = { calls: [] as [string, Record<string, unknown>][], fail: false };
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: async (command: string, args: Record<string, unknown>) => {
    await Promise.resolve();
    fake.calls.push([command, args]);
    if (fake.fail) throw new Error('offline');
  },
}));

const { printLabels } = await import('../../src/features/items/labels/printer');

const image = {
  canvas: null as unknown as HTMLCanvasElement,
  bits: new Uint8Array(40 * 8).fill(0xff),
  widthBytes: 40,
  widthDots: 320,
  height: 8,
};
const size = { widthMm: 40, heightMm: 30 };

beforeEach(() => {
  fake.calls = [];
  fake.fail = false;
});

describe('the way labels reach the printer', () => {
  it('Direct (TSPL): the TSPL job, RAW, with the copies in it', async () => {
    const config = { ...DEFAULT_LABEL_PRINTER, printer: 'LABEL', mode: 'tspl' as const };
    expect(await printLabels(image, size, config, 5, 'labels-X')).toEqual({ printed: true });
    expect(fake.calls).toHaveLength(1);
    const [command, args] = fake.calls[0] as [string, { dataBase64: string; printer: string }];
    expect(command).toBe('printer_print');
    expect(args.printer).toBe('LABEL');
    const text = Buffer.from(args.dataBase64, 'base64').toString('latin1');
    expect(text.startsWith('SIZE 40 mm,30 mm\r\n')).toBe(true);
    expect(text.endsWith('\r\nPRINT 1,5\r\n')).toBe(true);
  });

  it('Windows driver: the image to the driver', async () => {
    const config = { ...DEFAULT_LABEL_PRINTER, printer: 'LABEL' };
    expect(await printLabels(image, size, config, 2, 'labels-X')).toEqual({ printed: true });
    expect(fake.calls.map((c) => c[0])).toEqual(['printer_print_label']);
  });

  it('a failed direct print is reported, not sent again through the driver', async () => {
    fake.fail = true;
    const config = { ...DEFAULT_LABEL_PRINTER, printer: 'LABEL', mode: 'tspl' as const };
    expect(await printLabels(image, size, config, 1, 'labels-X')).toMatchObject({
      printed: false,
      reason: 'failed_direct',
    });
    expect(fake.calls.map((c) => c[0])).toEqual(['printer_print']);
  });
});
