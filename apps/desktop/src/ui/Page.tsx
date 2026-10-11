/**
 * Page building blocks for the list screens (designs 07 and 14): the page title with its
 * buttons, summary tiles, a list with a detail panel beside it, the search/filter bar, and small
 * pieces used inside them.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Info } from 'lucide-react';
import styles from './Page.module.css';
import { Card, Tile, type Tone } from './Surface';
import { cx } from './cx';

export const pageClasses = styles;

/** The design's `.page-h`: title, one line under it, and the page's buttons on the other side. */
export function PageHeader(props: { title: ReactNode; subtitle?: ReactNode; tools?: ReactNode }) {
  return (
    <div className={cx(styles.pageHeader, 'rise')}>
      <div>
        <h1>{props.title}</h1>
        {props.subtitle && <p>{props.subtitle}</p>}
      </div>
      {props.tools && <div className={styles.tools}>{props.tools}</div>}
    </div>
  );
}

/** The design's `.kpis`: a row of summary tiles. */
export function Kpis({ children }: { children: ReactNode }) {
  return <div className={styles.kpis}>{children}</div>;
}

export function Kpi(props: {
  icon: ReactNode;
  label: ReactNode;
  value: ReactNode;
  tone?: Tone;
  index?: number;
}) {
  return (
    <Card rise index={props.index} className={styles.kpi}>
      <Tile tone={props.tone}>{props.icon}</Tile>
      <div>
        <span className={styles.kpiLabel}>{props.label}</span>
        <b>{props.value}</b>
      </div>
    </Card>
  );
}

/** The design's `.layout`: the list, and the selected record's details beside it. */
export function SplitView(props: { list: ReactNode; detail?: ReactNode }) {
  return (
    <div className={styles.layout}>
      <div className={styles.layoutMain}>{props.list}</div>
      <aside className={styles.detail} aria-live="polite">
        {props.detail}
      </aside>
    </div>
  );
}

/** The design's `.bar`: search on the start side, filters on the end side. */
export function ToolBar({ children, index }: { children: ReactNode; index?: number }) {
  return (
    <div
      className={cx(styles.bar, 'rise')}
      style={index !== undefined ? ({ '--i': index } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

/** A definition list (the design's `.dl`): label on one side, value on the other. */
export function DefinitionList(props: { rows: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className={styles.dl}>
      {props.rows.map((row, i) => (
        <div key={i}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The design's `.offbar`: a quiet explanation with an info icon. */
export function InfoBar({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className={styles.infoBar}>
      {icon ?? <Info aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}

/** Shown when a list has nothing in it. */
export function EmptyState({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

/** Tabs that switch what a page shows (React state, not addresses). */
export function Tabs<T extends string>(props: {
  label: string;
  value: T;
  tabs: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="tablist" aria-label={props.label} className={styles.tabs}>
      {props.tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === props.value}
          onClick={() => props.onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
