/**
 * Barcode scanners in search fields. A scanner types like a keyboard, very fast, usually followed by
 * Enter. Two things go wrong without help:
 * - with Windows set to the Arabic keyboard, the letters of a code come out as the Arabic letters on
 *   the same keys ("TEST-1234" arrives as "لإُ ٍلإ-1234"); digits are not affected;
 * - a second scan is added after the first one instead of replacing it.
 * `fromArabicKeyboard` turns the Arabic letters back into the keys pressed; `useScanInput` notices a
 * scan (many keys within a few milliseconds each), gives the code back in Latin letters, and makes
 * the next scan (or typing after a pause) replace it. Names typed by a person stay as typed.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';

/** The Arabic (101) keyboard: what each key gives, and the US key it is (Shift = capital). */
// prettier-ignore
const KEYS: Record<string, string> = {
  // Lam-alef: one key, two letters.
  'لإ': 'T', 'لأ': 'G', 'لآ': 'B', 'لا': 'b',
  'ض': 'q', 'ص': 'w', 'ث': 'e', 'ق': 'r', 'ف': 't', 'غ': 'y', 'ع': 'u', 'ه': 'i', 'خ': 'o', 'ح': 'p',
  'ج': '[', 'د': ']', 'ش': 'a', 'س': 's', 'ي': 'd', 'ب': 'f', 'ل': 'g', 'ا': 'h', 'ت': 'j', 'ن': 'k',
  'م': 'l', 'ك': ';', 'ط': "'", 'ئ': 'z', 'ء': 'x', 'ؤ': 'c', 'ر': 'v', 'ى': 'n', 'ة': 'm', 'و': ',',
  'ز': '.', 'ظ': '/', 'ذ': '`',
  // With Shift: the vowel marks and the other letters.
  'َ': 'Q', 'ً': 'W', 'ُ': 'E', 'ٌ': 'R', 'إ': 'Y', '‘': 'U', '÷': 'I',
  '×': 'O', '؛': 'P', 'ِ': 'A', 'ٍ': 'S', 'أ': 'H', 'ـ': 'J', '،': 'K', 'ْ': 'X',
  'آ': 'N', '’': 'M', '؟': '?', 'ّ': '~',
  // Shift keys that give a Latin symbol on the Arabic keyboard. Read so only next to Arabic letters:
  // there a real symbol could not have come from its own key.
  '~': 'Z', '{': 'V', '}': 'C', '[': 'F', ']': 'D', '/': 'L',
};

const ARABIC = /[؀-ۿ‘’÷×]/;

/**
 * The keys a scanner pressed, when Windows turned them into Arabic letters. Text that is not made of
 * keyboard letters (a real Arabic name) comes back unchanged.
 */
export function fromArabicKeyboard(text: string): string {
  if (!ARABIC.test(text)) return text;
  let out = '';
  for (let i = 0; i < text.length;) {
    const two = KEYS[text.slice(i, i + 2)];
    if (two && text[i] === 'ل') {
      out += two;
      i += 2;
      continue;
    }
    const one = KEYS[text[i]!];
    if (one === undefined && ARABIC.test(text[i]!)) return text;
    out += one ?? text[i];
    i += 1;
  }
  return /^[\x21-\x7E]+$/.test(out) ? out : text;
}

/** A pause this long (ms) ends a scan; a person types slower than SCAN_KEY_MS between keys. */
const PAUSE_MS = 300;
const SCAN_KEY_MS = 45;
const SCAN_MIN_KEYS = 4;

/** True when the keys came as fast as a scanner types them. */
export function isScanBurst(times: number[]): boolean {
  if (times.length < SCAN_MIN_KEYS) return false;
  return (times.at(-1)! - times[0]!) / (times.length - 1) < SCAN_KEY_MS;
}

/** A key that types something (Arabic lam-alef is one key with two letters). */
const types = (event: KeyboardEvent<HTMLInputElement>) =>
  !event.ctrlKey &&
  !event.metaKey &&
  !event.altKey &&
  [...event.key].length <= 2 &&
  event.key !== ' ';

/**
 * Scanner help for one search field: call `onKeyDown` first in the field's own key handler, and pass
 * the text through `read` before using it on Enter. `onScanned` is called when a scan ends without
 * Enter (scanners set up without it), with the code in Latin letters.
 */
export function useScanInput(onScanned?: (code: string) => void) {
  const keys = useRef<number[]>([]);
  const scanned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  const callback = useRef(onScanned);
  callback.current = onScanned;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /** The scan is over: the next scan, or typing after a pause, replaces it. */
  const finish = () => {
    if (!isScanBurst(keys.current)) return false;
    scanned.current = true;
    const input = field.current;
    if (input) requestAnimationFrame(() => input.select());
    return true;
  };

  return {
    onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      field.current = event.currentTarget;
      if (event.key === 'Enter') {
        if (timer.current) clearTimeout(timer.current);
        finish();
        return;
      }
      if (!types(event)) return;
      // When the key arrived, not when this page got round to it: a busy screen must not make
      // a scanner look like a person typing.
      const now = event.timeStamp;
      const last = keys.current.at(-1);
      if (last === undefined || now - last > PAUSE_MS) {
        // A new scan or new typing: replaces the code scanned before, as a whole.
        if (scanned.current) event.currentTarget.select();
        scanned.current = false;
        keys.current = [];
      }
      keys.current.push(now);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const input = field.current;
        if (input && finish()) callback.current?.(fromArabicKeyboard(input.value.trim()));
      }, PAUSE_MS);
    },
    /** The text as it should be used: a scanned code in Latin letters, anything typed unchanged. */
    read(text: string): string {
      return isScanBurst(keys.current) ? fromArabicKeyboard(text) : text;
    },
  };
}

/** True when the key went into something a person types in (a field, a list, an editor). */
const typingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role="listbox"], [role="menu"], [role="grid"]') !== null);

/**
 * A scan anywhere on the screen (decision 0096 follow-up): while the cursor is not in a field and
 * no window is open, a scanner's burst of keys ending in Enter (or a pause) is caught and given to
 * `onScan` in Latin letters, so nobody has to click the search box first. Keys typed by a person
 * are too slow to look like a scan and are left alone; the Enter that ends a scan is kept from
 * pressing whatever button has the focus.
 */
export function useGlobalScan(onScan: (code: string) => void, enabled = true) {
  const callback = useRef(onScan);
  callback.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    let keys: string[] = [];
    let times: number[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reset = () => {
      keys = [];
      times = [];
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const finish = () => {
      const code = fromArabicKeyboard(keys.join('').trim());
      const scanned = isScanBurst(times) && code !== '';
      reset();
      if (scanned) callback.current(code);
      return scanned;
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (typingTarget(event.target) || document.querySelector('[role="dialog"]')) {
        reset();
        return;
      }
      if (event.key === 'Enter') {
        if (finish()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return reset();
      if ([...event.key].length > 2 || event.key === ' ') return;
      const now = event.timeStamp;
      const last = times.at(-1);
      if (last !== undefined && now - last > PAUSE_MS) reset();
      keys.push(event.key);
      times.push(now);
      if (timer) clearTimeout(timer);
      // Scanners set up without Enter: the pause ends the scan.
      timer = setTimeout(finish, PAUSE_MS);
    };
    // Capture: the scan is seen before any button or list reacts to its keys.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      reset();
    };
  }, [enabled]);
}
