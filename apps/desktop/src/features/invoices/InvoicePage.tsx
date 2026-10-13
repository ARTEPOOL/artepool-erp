/**
 * One invoice: a draft being written (`new` or a saved draft) or a saved document (issued or
 * discarded, read-only). An issued document never changes; corrections are credit or debit notes.
 */
import { ArrowLeft, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from '@tanstack/react-router';
import { Alert, cx, EmptyState, iconClass, InfoBar, pageClasses, PageHeader } from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { useDocument } from '../sales/api';
import { DocumentView } from './DocumentView';
import { DraftEditor } from './DraftEditor';
import styles from './invoices.module.css';

export function InvoicePage() {
  const { t } = useTranslation('invoices');
  const can = useCan();
  const errorText = useErrorText();
  const { documentId } = useParams({ from: '/invoices/$documentId' });
  const isNew = documentId === 'new';
  const allowed = can('invoices.view') && (!isNew || can('invoices.create'));
  const doc = useDocument(isNew || !allowed ? null : documentId);
  const data = doc.data;

  const back = (
    <Link to="/invoices" className={styles.backLink}>
      <ArrowLeft className={cx(iconClass.sm, styles.flip)} aria-hidden="true" />
      {t('form.back')}
    </Link>
  );

  if (!allowed) {
    return (
      <div className={pageClasses.page}>
        <PageHeader title={t('title')} tools={back} />
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('sales:noAccess')}</InfoBar>
      </div>
    );
  }

  if (isNew) {
    return (
      <div className={pageClasses.page}>
        <PageHeader title={t('form.newTitle')} subtitle={t('form.newSubtitle')} tools={back} />
        <DraftEditor key="new" doc={null} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className={pageClasses.page}>
        <PageHeader title={t('title')} tools={back} />
        {doc.isError ? (
          <Alert>{errorText(doc.error)}</Alert>
        ) : (
          <EmptyState>{t('sales:loading')}</EmptyState>
        )}
      </div>
    );
  }

  const editable = data.status === 'draft' && data.docType === 'invoice' && can('invoices.create');
  return (
    <div className={pageClasses.page}>
      <PageHeader
        title={
          data.docNumber ? (
            <bdi>{data.docNumber}</bdi>
          ) : (
            t(data.status === 'discarded' ? 'form.discardedTitle' : 'form.draftTitle')
          )
        }
        subtitle={`${t(`sales:docTypes.${data.docType}`)} · ${data.billToName}`}
        tools={back}
      />
      {editable ? (
        // A save gives a new version: the editor starts again from the server's figures.
        <DraftEditor key={`${data.id}:${data.rowVersion}`} doc={data} />
      ) : (
        <DocumentView doc={data} />
      )}
    </div>
  );
}
