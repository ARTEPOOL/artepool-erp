/**
 * A search box whose suggestions open as soon as it gets focus (the first entries, before
 * anything is typed) and narrow as the person types. Arrow keys move into the list and through
 * it; Escape closes it; leaving the box closes it.
 */
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

export function useSuggest(delayMs = 250) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), delayMs);
    return () => clearTimeout(timer);
  }, [text, delayMs]);

  const buttons = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  const reset = () => {
    setText('');
    setQ('');
    setOpen(false);
  };

  return {
    text,
    q,
    open,
    listRef,
    reset,
    /** Props for the wrapper around the input and the list. */
    container: {
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === 'Escape') {
          setOpen(false);
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const list = buttons();
        if (list.length === 0) return;
        event.preventDefault();
        setOpen(true);
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === 'ArrowDown'
            ? list[Math.min(at + 1, list.length - 1)]
            : at <= 0
              ? null
              : list[at - 1];
        if (next) next.focus();
        else event.currentTarget.querySelector<HTMLInputElement>('input')?.focus();
      },
    },
    /** Props for the search input. */
    input: {
      value: text,
      onFocus: () => setOpen(true),
      onChange: (event: { target: { value: string } }) => {
        setText(event.target.value);
        setOpen(true);
      },
    },
    setQ,
    setOpen,
  };
}
