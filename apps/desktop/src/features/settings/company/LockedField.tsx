import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Chip } from '../../../ui';
import styles from './company.module.css';

/**
 * The design's `.lockf`: a setting shown but never changed here (fixed by a decision), with its
 * "Locked" chip. Used by Company → General and VAT & numbering → Calculation.
 */
export function LockedField({ label, children }: { label: ReactNode; children: ReactNode }) {
  const { t } = useTranslation('setup');
  return (
    <div className={styles.lockedField}>
      <span className={styles.lockedLabel}>{label}</span>
      <div className={styles.lockf}>
        <span>{children}</span>
        <Chip icon={<Lock aria-hidden="true" />}>{t('company.locked')}</Chip>
      </div>
    </div>
  );
}

/** A list of locked fields, one under the other. */
export function LockedList({ children }: { children: ReactNode }) {
  return <div className={styles.lockedList}>{children}</div>;
}
