import type { ReactNode } from 'react';
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import styles from './Button.module.css';
import { cx } from './cx';

export type ButtonVariant = 'default' | 'primary' | 'fin' | 'ghost' | 'danger' | 'dangerGhost';

export interface ButtonProps extends Omit<AriaButtonProps, 'className' | 'children'> {
  variant?: ButtonVariant;
  size?: 'md' | 'lg';
  block?: boolean;
  /** Shows the button as working (the design's `.busy`) and ignores presses. */
  busy?: boolean;
  className?: string;
  children?: ReactNode;
}

/** The design's `.btn` (React Aria button: keyboard, press and focus handled for us). */
export function Button({
  variant = 'default',
  size = 'md',
  block = false,
  busy = false,
  className,
  ...rest
}: ButtonProps) {
  return (
    <AriaButton
      {...rest}
      className={cx(
        styles.btn,
        variant === 'dangerGhost' ? cx(styles.ghost, styles.dangerText) : styles[variant],
        size === 'lg' && styles.lg,
        block && styles.block,
        busy && styles.busy,
        className,
      )}
    />
  );
}

export interface IconButtonProps extends Omit<AriaButtonProps, 'className' | 'children'> {
  /** Required: icon buttons have no visible text (translated). */
  'aria-label': string;
  className?: string;
  children: ReactNode;
}

/** The design's `.icon-btn`. */
export function IconButton({ className, ...rest }: IconButtonProps) {
  return <AriaButton {...rest} className={cx(styles.iconBtn, className)} />;
}

/** Icon size classes (the design's `svg.i` and `svg.i-sm`). */
export const iconClass = { md: styles.icon, sm: styles.iconSm } as const;
