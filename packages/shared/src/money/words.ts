/**
 * An amount in words for printed documents (decision 0064, optional field "Amount in words"):
 * "ثلاثة آلاف وخمسمائة وسبعون درهمًا فقط" and "Three thousand five hundred seventy UAE dirhams
 * only". Dirhams and fils are written separately; the amount is exact to the fils.
 */
import type { Fils } from './units';

// ---------------------------------------------------------------------------------------------
// Arabic (the counted nouns, درهم and فلس, are masculine)
// ---------------------------------------------------------------------------------------------

const AR_ONES = [
  '',
  'واحد',
  'اثنان',
  'ثلاثة',
  'أربعة',
  'خمسة',
  'ستة',
  'سبعة',
  'ثمانية',
  'تسعة',
  'عشرة',
  'أحد عشر',
  'اثنا عشر',
  'ثلاثة عشر',
  'أربعة عشر',
  'خمسة عشر',
  'ستة عشر',
  'سبعة عشر',
  'ثمانية عشر',
  'تسعة عشر',
];
const AR_TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const AR_HUNDREDS = [
  '',
  'مائة',
  'مائتان',
  'ثلاثمائة',
  'أربعمائة',
  'خمسمائة',
  'ستمائة',
  'سبعمائة',
  'ثمانمائة',
  'تسعمائة',
];

/** 1–999 in words. */
function arBelowThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(AR_HUNDREDS[hundreds]!);
  if (rest > 0 && rest < 20) parts.push(AR_ONES[rest]!);
  else if (rest >= 20) {
    const ones = rest % 10;
    parts.push(
      ones > 0 ? `${AR_ONES[ones]} و${AR_TENS[Math.floor(rest / 10)]}` : AR_TENS[rest / 10]!,
    );
  }
  return parts.join(' و');
}

/**
 * A count with its noun, following Arabic agreement:
 * 1 → noun + one; 2 → dual; 3–10 → plural; 11–99 (last two digits) → accusative singular;
 * otherwise (100, 101, 102, 200…) → singular.
 */
function arCounted(
  n: number,
  noun: { one: string; two: string; few: string; many: string; plain: string },
  withOne = false,
): string {
  if (n === 1) return withOne ? `${noun.one} ${AR_ONES[1]}` : noun.one;
  if (n === 2) return noun.two;
  const last2 = n % 100;
  const words = arNumber(n);
  if (last2 >= 3 && last2 <= 10) return `${words} ${noun.few}`;
  if (last2 >= 11) return `${words} ${noun.many}`;
  return `${words} ${noun.plain}`;
}

const AR_SCALES = [
  {
    value: 1_000_000_000,
    one: 'مليار',
    two: 'ملياران',
    few: 'مليارات',
    many: 'مليارًا',
    plain: 'مليار',
  },
  {
    value: 1_000_000,
    one: 'مليون',
    two: 'مليونان',
    few: 'ملايين',
    many: 'مليونًا',
    plain: 'مليون',
  },
  { value: 1_000, one: 'ألف', two: 'ألفان', few: 'آلاف', many: 'ألفًا', plain: 'ألف' },
];

/** A whole number in Arabic words (0 → "صفر"). */
function arNumber(n: number): string {
  if (n === 0) return 'صفر';
  const parts: string[] = [];
  let rest = n;
  for (const scale of AR_SCALES) {
    const count = Math.floor(rest / scale.value);
    if (count > 0) parts.push(arCounted(count, scale));
    rest %= scale.value;
  }
  if (rest > 0) parts.push(arBelowThousand(rest));
  return parts.join(' و');
}

const DIRHAM = { one: 'درهم', two: 'درهمان', few: 'دراهم', many: 'درهمًا', plain: 'درهم' };
const FILS = { one: 'فلس', two: 'فلسان', few: 'فلوس', many: 'فلسًا', plain: 'فلس' };

/** "مائة وخمسة وعشرون درهمًا وخمسون فلسًا فقط". */
export function amountInWordsAr(amount: Fils): string {
  const { dirhams, fils } = split(amount);
  const parts: string[] = [];
  if (dirhams > 0 || fils === 0) parts.push(arCounted(dirhams, DIRHAM, true));
  if (fils > 0) parts.push(arCounted(fils, FILS, true));
  return `${parts.join(' و')} فقط`;
}

// ---------------------------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------------------------

const EN_ONES = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];
const EN_SCALES: [number, string][] = [
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand'],
];

function enBelowThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${EN_ONES[hundreds]} hundred`);
  if (rest > 0 && rest < 20) parts.push(EN_ONES[rest]!);
  else if (rest >= 20) {
    const ones = rest % 10;
    parts.push(EN_TENS[Math.floor(rest / 10)]! + (ones > 0 ? `-${EN_ONES[ones]}` : ''));
  }
  return parts.join(' ');
}

function enNumber(n: number): string {
  if (n === 0) return 'zero';
  const parts: string[] = [];
  let rest = n;
  for (const [value, name] of EN_SCALES) {
    const count = Math.floor(rest / value);
    if (count > 0) parts.push(`${enBelowThousand(count)} ${name}`);
    rest %= value;
  }
  if (rest > 0) parts.push(enBelowThousand(rest));
  return parts.join(' ');
}

/** "One hundred twenty-five UAE dirhams and fifty fils only". */
export function amountInWordsEn(amount: Fils): string {
  const { dirhams, fils } = split(amount);
  const parts: string[] = [];
  if (dirhams > 0 || fils === 0) {
    parts.push(`${enNumber(dirhams)} UAE ${dirhams === 1 ? 'dirham' : 'dirhams'}`);
  }
  if (fils > 0) parts.push(`${enNumber(fils)} fils`);
  const text = `${parts.join(' and ')} only`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function split(amount: Fils): { dirhams: number; fils: number } {
  const value = BigInt(amount);
  if (value < 0n) throw new RangeError('An amount in words is never negative');
  if (value >= 100_000_000_000_000n) throw new RangeError('Amount too large to write in words');
  return { dirhams: Number(value / 100n), fils: Number(value % 100n) };
}
