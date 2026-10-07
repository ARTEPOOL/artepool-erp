/** Headers and small pieces shared by the Settings panels (design 13). */
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, cx } from '../../ui';
import styles from './settings.module.css';

export const settingsClasses = styles;

const rise = (index: number) => ({ '--i': index }) as CSSProperties;

export function PageHeader({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className={cx(styles.pageHeader, 'rise')}>
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
    </div>
  );
}

/** A panel's title, its one-line help, and its buttons on the other side. */
export function PanelHeader(props: { title: ReactNode; subtitle?: ReactNode; tools?: ReactNode }) {
  return (
    <div className={cx(styles.ph, 'rise')}>
      <div>
        <h2>{props.title}</h2>
        {props.subtitle && <p>{props.subtitle}</p>}
      </div>
      {props.tools && <div className={styles.tools}>{props.tools}</div>}
    </div>
  );
}

export function CardHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.cardHead}>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Section({
  index,
  className,
  children,
}: {
  index: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card rise index={index} className={cx(styles.sec, className)}>
      {children}
    </Card>
  );
}

export { rise };

/** "No access": the server refuses the page as well. */
export function NoAccess() {
  const { t } = useTranslation('settings');
  return <PanelHeader title={t('noAccess.title')} subtitle={t('noAccess.body')} />;
}
