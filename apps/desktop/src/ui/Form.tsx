import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import {
  Checkbox as AriaCheckbox,
  FieldError,
  Input,
  Label,
  Switch as AriaSwitch,
  Text,
  TextArea,
  TextField as AriaTextField,
} from 'react-aria-components';
import styles from './Form.module.css';
import { cx } from './cx';

export interface TextFieldProps {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  name?: string;
  type?: 'text' | 'password';
  size?: 'md' | 'lg';
  /** Codes, usernames and numbers are typed left to right in both languages. */
  ltr?: boolean;
  invalid?: boolean;
  error?: ReactNode;
  hint?: ReactNode;
  autoComplete?: string;
  autoFocus?: boolean;
  inputMode?: 'text' | 'numeric' | 'decimal';
  maxLength?: number;
  placeholder?: string;
  multiline?: boolean;
  isRequired?: boolean;
  isDisabled?: boolean;
  onKeyUp?: (event: React.KeyboardEvent) => void;
  className?: string;
}

/** The design's `<label class="field">` with `.input` (React Aria: label and errors wired up). */
export function TextField(props: TextFieldProps) {
  const inputClass = cx(
    styles.input,
    props.size === 'lg' && styles.lg,
    props.ltr && styles.ltr,
    props.invalid && styles.bad,
  );
  return (
    <AriaTextField
      className={cx(styles.field, props.className)}
      value={props.value}
      onChange={props.onChange}
      name={props.name}
      type={props.type ?? 'text'}
      isInvalid={props.invalid || props.error !== undefined}
      autoComplete={props.autoComplete}
      autoFocus={props.autoFocus}
      inputMode={props.inputMode}
      maxLength={props.maxLength}
      isRequired={props.isRequired}
      isDisabled={props.isDisabled}
    >
      <Label className={styles.label}>{props.label}</Label>
      {props.multiline ? (
        <TextArea className={inputClass} rows={2} placeholder={props.placeholder} />
      ) : (
        <Input className={inputClass} placeholder={props.placeholder} onKeyUp={props.onKeyUp} />
      )}
      {props.hint && (
        <Text slot="description" className={styles.hint}>
          {props.hint}
        </Text>
      )}
      {props.error && <FieldError className={styles.fieldError}>{props.error}</FieldError>}
    </AriaTextField>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** The design's `.select` (a native select: simple, accessible and works in RTL). */
export function SelectField(props: {
  label: ReactNode;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  id: string;
  isDisabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cx(styles.field, props.className)}>
      <label className={styles.label} htmlFor={props.id}>
        {props.label}
      </label>
      <select
        id={props.id}
        className={styles.select}
        value={props.value}
        disabled={props.isDisabled}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

/** The design's `.seg`: a row of buttons, one pressed. */
export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  block?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={props.label}
      className={cx(styles.seg, props.block && styles.segBlock, props.className)}
    >
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === props.value}
          onClick={() => props.onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The design's `.check` row. */
export function Checkbox(props: {
  isSelected: boolean;
  onChange: (value: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <AriaCheckbox
      isSelected={props.isSelected}
      onChange={props.onChange}
      className={cx(styles.check, props.className)}
    >
      <span className={styles.box} aria-hidden="true">
        {props.isSelected && <Check size={14} strokeWidth={3} />}
      </span>
      {props.children}
    </AriaCheckbox>
  );
}

/** The design's `.switch` with its label on the start side. */
export function Switch(props: {
  isSelected: boolean;
  onChange?: (value: boolean) => void;
  isDisabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <AriaSwitch
      isSelected={props.isSelected}
      onChange={props.onChange}
      isDisabled={props.isDisabled}
      className={cx(styles.switchRow, props.className)}
    >
      {props.children}
      <span className={styles.track} aria-hidden="true" />
    </AriaSwitch>
  );
}
