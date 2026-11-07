/** The server's own speed (M7, decision 0119): the 95th percentile of the last 1,000 of each. */
import { afterEach, describe, expect, it } from 'vitest';
import { percentile95, recordSpeed, resetSpeed, speedFigures } from '../../src/platform/http/speed';

afterEach(resetSpeed);

describe('the speed line', () => {
  it('the 95th percentile by nearest rank', () => {
    expect(percentile95([])).toBeNull();
    expect(percentile95([5])).toBe(5);
    expect(percentile95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(percentile95(Array.from({ length: 20 }, (_, i) => (i === 19 ? 900 : 10)))).toBe(10);
  });

  it('nothing measured yet, then slow only above the target', () => {
    expect(speedFigures().sale).toEqual({ p95Ms: null, samples: 0, targetMs: 2000, slow: false });
    for (let i = 0; i < 100; i++) recordSpeed('search', i < 90 ? 50 : 400);
    expect(speedFigures().search).toMatchObject({ p95Ms: 400, samples: 100, slow: true });
    for (let i = 0; i < 100; i++) recordSpeed('sale', 300);
    expect(speedFigures().sale).toMatchObject({ p95Ms: 300, slow: false });
  });

  it('keeps only the last 1,000', () => {
    for (let i = 0; i < 1500; i++) recordSpeed('scan', i < 500 ? 5000 : 20);
    expect(speedFigures().scan).toMatchObject({ samples: 1000, p95Ms: 20, slow: false });
  });
});
