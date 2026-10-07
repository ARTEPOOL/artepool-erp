import { Search } from 'lucide-react';
import styles from './Table.module.css';

/** Class names for tables in the design's style (`.tbl`, `table`, `.n`, `.s`, `.who`, …). */
export const tableClasses = styles;

/** The design's `.search` field: a magnifier and a plain input. */
export function SearchField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label className={`${styles.search} ${props.className ?? ''}`}>
      <Search aria-hidden="true" />
      <input
        type="search"
        aria-label={props.label}
        placeholder={props.label}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}
