import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cx } from '../../ui';
import styles from './auth.module.css';

const LENGTH = 6;

/** Arabic-Indic digits typed on an Arabic keyboard count as the same digits. */
export const toAsciiDigits = (text: string): string =>
  text
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));

/**
 * Six boxes for the 6-digit code (design 01, owner code): typing moves to the next box,
 * Backspace goes back, and pasting the whole code fills all boxes. Always left to right.
 */
export function OtpInput(props: {
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  autoFocus?: boolean;
  label: string;
}) {
  const { t } = useTranslation('auth');
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length: LENGTH }, (_, i) => props.value[i] ?? '');

  const setAt = (index: number, digit: string) => {
    const next = [...digits];
    next[index] = digit;
    props.onChange(next.join('').slice(0, LENGTH));
  };

  const onInput = (index: number, raw: string) => {
    const digit = toAsciiDigits(raw).replace(/\D/g, '').slice(-1);
    setAt(index, digit);
    if (digit && index < LENGTH - 1) inputs.current[index + 1]?.focus();
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      inputs.current[index - 1]?.focus();
      setAt(index - 1, '');
      event.preventDefault();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = toAsciiDigits(event.clipboardData.getData('text'))
      .replace(/\D/g, '')
      .slice(0, LENGTH);
    if (!pasted) return;
    event.preventDefault();
    props.onChange(pasted);
    inputs.current[Math.min(pasted.length, LENGTH - 1)]?.focus();
  };

  return (
    <div
      role="group"
      aria-label={props.label}
      className={cx(styles.otp, props.invalid && styles.bad)}
    >
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(element) => {
            inputs.current[index] = element;
          }}
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={2}
          value={digit}
          aria-label={t('secondFactor.digit', { n: index + 1 })}
          aria-invalid={props.invalid || undefined}
          autoFocus={props.autoFocus && index === 0}
          onChange={(event) => onInput(index, event.target.value)}
          onKeyDown={(event) => onKeyDown(index, event)}
          onPaste={onPaste}
          onFocus={(event) => event.target.select()}
        />
      ))}
    </div>
  );
}
