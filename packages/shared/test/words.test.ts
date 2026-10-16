import { describe, expect, it } from 'vitest';
import { amountInWordsAr, amountInWordsEn } from '../src/money/words';

describe('amount in words (decision 0064)', () => {
  it.each([
    [
      357_000n,
      'ثلاثة آلاف وخمسمائة وسبعون درهمًا فقط',
      'Three thousand five hundred seventy UAE dirhams only',
    ],
    [100n, 'درهم واحد فقط', 'One UAE dirham only'],
    [200n, 'درهمان فقط', 'Two UAE dirhams only'],
    [500n, 'خمسة دراهم فقط', 'Five UAE dirhams only'],
    [1_100n, 'أحد عشر درهمًا فقط', 'Eleven UAE dirhams only'],
    [10_000n, 'مائة درهم فقط', 'One hundred UAE dirhams only'],
    [
      12_550n,
      'مائة وخمسة وعشرون درهمًا وخمسون فلسًا فقط',
      'One hundred twenty-five UAE dirhams and fifty fils only',
    ],
    [5n, 'خمسة فلوس فقط', 'Five fils only'],
    [101n, 'درهم واحد وفلس واحد فقط', 'One UAE dirham and one fils only'],
    [0n, 'صفر درهم فقط', 'Zero UAE dirhams only'],
    [200_000n, 'ألفان درهم فقط', 'Two thousand UAE dirhams only'],
    [1_000_000n, 'عشرة آلاف درهم فقط', 'Ten thousand UAE dirhams only'],
    [11_000_000n, 'مائة وعشرة آلاف درهم فقط', 'One hundred ten thousand UAE dirhams only'],
    [
      150_000_000n,
      'مليون وخمسمائة ألف درهم فقط',
      'One million five hundred thousand UAE dirhams only',
    ],
    [
      2_500_000_00n,
      'مليونان وخمسمائة ألف درهم فقط',
      'Two million five hundred thousand UAE dirhams only',
    ],
  ])('%s fils', (fils, ar, en) => {
    expect(amountInWordsAr(fils)).toBe(ar);
    expect(amountInWordsEn(fils)).toBe(en);
  });

  it('never writes a negative or an impossible amount', () => {
    expect(() => amountInWordsAr(-1n)).toThrow(RangeError);
    expect(() => amountInWordsEn(100_000_000_000_000n)).toThrow(RangeError);
  });
});
