// @vitest-environment node
/**
 * Direct TSPL printing (decision 0100): the job's commands (size, gap, direction, darkness, speed,
 * one BITMAP, the number of copies) exactly; the label placed under the 48 mm head (a 50 mm label
 * cut to the head, centred; a 40 mm one started 4 mm in); the bits turned round (TSPL prints a
 * 0 bit black); and, for any drawing, the bitmap read back from the job is the drawing.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LABEL_PRINTER } from '@artepool/shared/contracts';
import { placeOnHead, tsplLabelJob } from '../../src/features/items/labels/tspl';

/** A drawing of `widthDots` × `height` with the given dots black (1 bit per dot, 1 = black). */
function image(widthDots: number, height: number, black: (x: number, y: number) => boolean) {
  const widthBytes = Math.ceil(widthDots / 8);
  const bits = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < widthDots; x += 1) {
      if (black(x, y)) bits[y * widthBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { bits, widthBytes, widthDots, height };
}

/** Splits a job into its text before the bitmap, the bitmap, and the text after it. */
function parse(job: Uint8Array) {
  const text = new TextDecoder('latin1').decode(job);
  const at = text.indexOf('BITMAP ');
  // BITMAP x,y,widthBytes,height,mode, then the data.
  const fields = text
    .slice(at + 7)
    .split(',')
    .slice(0, 5);
  const lineEnd = at + 7 + fields.join(',').length + 1;
  const [x, y, widthBytes, height] = fields.map(Number) as [number, number, number, number];
  const data = job.slice(lineEnd, lineEnd + widthBytes * height);
  return {
    head: text.slice(0, lineEnd),
    x,
    y,
    widthBytes,
    height,
    data,
    tail: text.slice(lineEnd + widthBytes * height),
  };
}

/** Whether the job prints the dot (x, y) of the bitmap black (TSPL: a 0 bit). */
const printsBlack = (p: ReturnType<typeof parse>, x: number, y: number) =>
  ((p.data[y * p.widthBytes + (x >> 3)]! >> (7 - (x & 7))) & 1) === 0;

const config = { ...DEFAULT_LABEL_PRINTER, printer: 'LABEL' };

describe('the TSPL job', () => {
  it('50 × 30 at 203 dpi: the commands, cut to the 48 mm head, 3 copies', () => {
    const job = tsplLabelJob(
      image(400, 240, () => false),
      { widthMm: 50, heightMm: 30 },
      config,
      3,
    );
    const p = parse(job);
    expect(p.head).toBe(
      [
        'SIZE 50 mm,30 mm',
        'GAP 2 mm,0 mm',
        'DIRECTION 1,0',
        'REFERENCE 0,0',
        'DENSITY 8',
        'SPEED 3',
        'CLS',
        'BITMAP 0,0,48,240,0,',
      ].join('\r\n'),
    );
    // 384 dots (48 mm) of the 400, all white: every bit 1.
    expect(p.data).toHaveLength(48 * 240);
    expect(p.data.every((b) => b === 0xff)).toBe(true);
    expect(p.tail).toBe('\r\nPRINT 1,3\r\n');
  });

  it('a 40 mm label starts 4 mm (32 dots) in on the 48 mm head', () => {
    const p = parse(
      tsplLabelJob(
        image(320, 240, () => false),
        { widthMm: 40, heightMm: 30 },
        config,
        1,
      ),
    );
    expect([p.x, p.y, p.widthBytes, p.height]).toEqual([32, 0, 40, 240]);
    expect(placeOnHead(320, 384)).toEqual({ first: 0, width: 320, x: 32 });
    expect(placeOnHead(400, 384)).toEqual({ first: 8, width: 384, x: 0 });
  });

  it('black stays black (a 0 bit), and the cut is centred', () => {
    // Column 8 of a 50 mm drawing is the head's first dot; column 391 its last.
    const drawing = image(400, 4, (x) => x === 8 || x === 391);
    const p = parse(tsplLabelJob(drawing, { widthMm: 50, heightMm: 30 }, config, 1));
    for (let y = 0; y < 4; y += 1) {
      expect(printsBlack(p, 0, y)).toBe(true);
      expect(printsBlack(p, 1, y)).toBe(false);
      expect(printsBlack(p, 383, y)).toBe(true);
    }
    expect(p.data[0]).toBe(0x7f);
  });

  it('darkness, speed, the gap and the direction come from the PC settings', () => {
    const p = parse(
      tsplLabelJob(
        image(320, 8, () => false),
        { widthMm: 40, heightMm: 30 },
        { ...config, darkness: 12, speed: 2, gapMm: 2.5, flip: true },
        1,
      ),
    );
    expect(p.head).toContain('GAP 2.5 mm,0 mm\r\nDIRECTION 0,0');
    expect(p.head).toContain('DENSITY 12\r\nSPEED 2');
    expect(() =>
      tsplLabelJob(
        image(8, 1, () => false),
        { widthMm: 40, heightMm: 30 },
        config,
        0,
      ),
    ).toThrow();
  });

  it('property: the bitmap in the job is the drawing (cut and placed), at 203 and 300 dpi', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(203, 300),
        fc.constantFrom(40, 50),
        fc.integer({ min: 1, max: 12 }),
        fc.integer(),
        (dpi, widthMm, height, seed) => {
          const widthDots = Math.round((widthMm * dpi) / 25.4);
          const black = (x: number, y: number) => ((x * 31 + y * 17 + seed) & 7) === 0;
          const p = parse(
            tsplLabelJob(
              image(widthDots, height, black),
              { widthMm, heightMm: 30 },
              { ...config, dpi: dpi },
              1,
            ),
          );
          const head = Math.round((48 * dpi) / 25.4);
          const { first, width } = placeOnHead(widthDots, head);
          for (let y = 0; y < height; y += 1) {
            for (let x = 0; x < width; x += 1) {
              if (printsBlack(p, x, y) !== black(first + x, y)) return false;
            }
          }
          return p.height === height && p.widthBytes === Math.ceil(width / 8);
        },
      ),
    );
  });
});
