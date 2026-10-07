import type { CSSProperties, ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import styles from './Surface.module.css';
import { cx } from './cx';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'credit' | 'primary';

const toneClass = (tone: Tone) => (tone === 'neutral' ? undefined : styles[tone]);

interface BoxProps {
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** The design's `.card`. `rise` animates it in (with `index` for the stagger). */
export function Card({
  className,
  style,
  children,
  rise,
  index,
}: BoxProps & { rise?: boolean; index?: number }) {
  return (
    <div
      className={cx(styles.card, rise && 'rise', className)}
      style={index !== undefined ? ({ ...style, '--i': index } as CSSProperties) : style}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.cardHeader}>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** Status = text + icon + colour (design rule), never colour alone. */
export function Chip({
  tone = 'neutral',
  icon,
  children,
  className,
}: BoxProps & { tone?: Tone; icon?: ReactNode }) {
  return (
    <span className={cx(styles.chip, toneClass(tone), className)}>
      {icon}
      {children}
    </span>
  );
}

export function Tile({ tone = 'neutral', children, className }: BoxProps & { tone?: Tone }) {
  return <span className={cx(styles.tile, toneClass(tone), className)}>{children}</span>;
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cx(styles.avatar, className)} aria-hidden="true">
      {[...name.trim()][0] ?? ''}
    </span>
  );
}

export function Brand({ children, className }: BoxProps) {
  return <span className={cx(styles.brand, className)}>{children}</span>;
}

/** A small explanatory line with an info icon (the design's `.note`). */
export function Note({ children, className }: BoxProps) {
  return (
    <p className={cx(styles.note, className)}>
      <Info aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** An error or warning message box (the design's `.err`); announced to screen readers. */
export function Alert({
  tone = 'danger',
  icon,
  shake = false,
  children,
  className,
}: BoxProps & { tone?: 'danger' | 'warn'; icon?: ReactNode; shake?: boolean }) {
  return (
    <div
      role="alert"
      className={cx(styles.alert, tone === 'warn' && styles.alertWarn, shake && 'shake', className)}
    >
      {icon ?? <AlertTriangle aria-hidden="true" />}
      <div>{children}</div>
    </div>
  );
}
