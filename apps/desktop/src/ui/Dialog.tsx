import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { IconButton, iconClass } from './Button';
import styles from './Dialog.module.css';
import { cx } from './cx';

/**
 * The design's `.dlg`: a modal dialog with a title and a close button. React Aria traps focus,
 * closes on Escape and returns focus to the button that opened it.
 */
export function Dialog(props: {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  wide?: boolean;
  /** When false, clicking outside does not close (e.g. a code shown once). */
  dismissable?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation('shell');
  return (
    <ModalOverlay
      isOpen={props.isOpen}
      onOpenChange={(open) => !open && props.onClose()}
      isDismissable={props.dismissable ?? true}
      className={styles.overlay}
    >
      <Modal className={cx(styles.modal, props.wide && styles.wide)}>
        <AriaDialog className={styles.dialog}>
          <div className={styles.header}>
            <Heading slot="title">{props.title}</Heading>
            <IconButton aria-label={t('close')} onPress={props.onClose}>
              <X className={iconClass.md} aria-hidden="true" />
            </IconButton>
          </div>
          {props.children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className={styles.footer}>{children}</div>;
}
