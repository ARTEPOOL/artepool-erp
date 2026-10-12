import { useState, type FormEvent } from 'react';
import { CheckCircle2, Lock, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AdjustmentDetail,
  AdjustmentItem,
  ReviewOversellRequest,
  PersonName,
} from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import { formatDate, formatDateTime } from '../../lib/format';
import {
  Alert,
  Button,
  Card,
  Dialog,
  DialogFooter,
  EmptyState,
  iconClass,
  InfoBar,
  pageClasses,
  PageHeader,
  tableClasses as tbl,
  Tabs,
  TextField,
  useToast,
} from '../../ui';
import { useCan, useDisplayName, useErrorText } from '../auth/context';
import { money } from '../masterdata/format';
import { localName, useUnits } from '../masterdata/refs';
import { STOCK_INVALIDATE, STOCK_PATHS, useAdjustment, useAdjustments } from './api';
import { quantityShort, SaveError, useUnitOf } from './parts';
import styles from './inventory.module.css';

type Tab = 'pending' | 'reviewed';

/** "Mark reviewed" with a note (decision 0003): the storekeeper says what they checked. */
function ReviewDialog(props: { doc: AdjustmentItem; onClose: () => void }) {
  const { t } = useTranslation('inventory');
  const { t: tm } = useTranslation('masterdata');
  const toast = useToast();
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const review = useSave(
    (a, body: ReviewOversellRequest, key) =>
      a.post<AdjustmentDetail>(STOCK_PATHS.review(props.doc.id), body, { idempotencyKey: key }),
    {
      invalidate: STOCK_INVALIDATE,
      onSuccess: () => {
        toast(t('reviews.dialog.done'));
        props.onClose();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (note.trim().length < 3) return setProblem(t('reviews.dialog.noteTooShort'));
    review.mutate({ note: note.trim(), rowVersion: props.doc.rowVersion });
  };
  return (
    <Dialog isOpen onClose={props.onClose} title={t('reviews.dialog.title')}>
      <form onSubmit={submit} noValidate className={styles.form}>
        <InfoBar>{t('reviews.dialog.explain')}</InfoBar>
        <p>
          <bdi className={styles.numberCell}>{props.doc.docNumber ?? '—'}</bdi>
          {' · '}
          <bdi>{formatDate(props.doc.date)}</bdi>
        </p>
        <TextField
          label={t('reviews.dialog.note')}
          value={note}
          onChange={setNote}
          placeholder={t('reviews.dialog.noteHint')}
          multiline
          isRequired
          invalid={problem !== null}
        />
        {problem && <Alert>{problem}</Alert>}
        <SaveError error={review.error} />
        <DialogFooter>
          <Button onPress={props.onClose}>{tm('actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={review.isPending}>
            {t('reviews.dialog.confirm')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** One oversell: its item lines come from the document itself. */
function OversellRow(props: {
  doc: AdjustmentItem;
  tab: Tab;
  onReview: (doc: AdjustmentItem) => void;
}) {
  const { t, i18n } = useTranslation('inventory');
  const name = localName(i18n.language);
  const nameOf = useDisplayName();
  const can = useCan();
  const units = useUnits();
  const unitOf = useUnitOf(units.data);
  const detail = useAdjustment(props.doc.id);
  const values = can('stock.view_cost');
  const { doc } = props;
  const person = (found: PersonName | null) => (found ? nameOf(found) : '—');
  const lines = detail.data?.lines ?? [];
  return (
    <tr>
      <td className={styles.numberCell}>
        <bdi>{doc.docNumber ?? '—'}</bdi>
      </td>
      <td>
        <bdi>{formatDate(doc.date)}</bdi>
      </td>
      <td>
        {lines.map((l) => (
          <span key={l.lineNo} className={styles.lineItem}>
            <b>{name(l)}</b> <bdi className={styles.muted}>{l.itemCode}</bdi>
          </span>
        ))}
      </td>
      <td className={tbl.num}>
        {lines.map((l) => (
          <span key={l.lineNo} className={styles.lineItem}>
            <bdi>{quantityShort(BigInt(l.quantityMilli))}</bdi> {unitOf(l.unitId).name}
          </span>
        ))}
      </td>
      {values && (
        <td className={tbl.num}>
          <bdi>{doc.totalValueFils ? money(BigInt(doc.totalValueFils)) : '—'}</bdi>
        </td>
      )}
      <td>
        {person(doc.postedByName)}
        {doc.approvedByName && (
          <span className={tbl.sub}>
            {t('reviews.approvedBy', { name: nameOf(doc.approvedByName) })}
          </span>
        )}
      </td>
      {props.tab === 'reviewed' ? (
        <td>
          {person(doc.reviewedByName)}
          {doc.reviewedAt && (
            <span className={tbl.sub}>
              <bdi>{formatDateTime(doc.reviewedAt)}</bdi>
            </span>
          )}
          {doc.reviewNote && <span className={tbl.sub}>{doc.reviewNote}</span>}
        </td>
      ) : (
        can('stock.oversell_review') && (
          <td className={tbl.num}>
            <Button
              onPress={() => props.onReview(doc)}
              aria-label={t('reviews.markOf', { number: doc.docNumber ?? '' })}
            >
              <CheckCircle2 className={iconClass.sm} aria-hidden="true" />
              {t('reviews.mark')}
            </Button>
          </td>
        )
      )}
    </tr>
  );
}

/**
 * Oversell reviews (decision 0003): every sale beyond the stock on hand, approved by a
 * supervisor at the POS, posts an oversell adjustment that the storekeeper reviews here.
 */
export function ReviewsPage() {
  const { t } = useTranslation('inventory');
  const can = useCan();
  const errorText = useErrorText();
  const [tab, setTab] = useState<Tab>('pending');
  const [reviewing, setReviewing] = useState<AdjustmentItem | null>(null);
  const allowed = can('stock.view');
  const list = useAdjustments('oversell', tab, allowed);
  const values = can('stock.view_cost');
  const docs = list.data?.adjustments ?? [];
  const showAction = tab === 'reviewed' || can('stock.oversell_review');
  const columns = 5 + (values ? 1 : 0) + (showAction ? 1 : 0);

  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('reviews.title')} subtitle={t('reviews.subtitle')} />
      {!allowed ? (
        <InfoBar icon={<Lock aria-hidden="true" />}>{t('noAccess')}</InfoBar>
      ) : (
        <>
          <InfoBar icon={<ShieldCheck aria-hidden="true" />}>{t('reviews.explain')}</InfoBar>
          <Card rise index={1} padding="table">
            <div className={styles.tabsRow}>
              <Tabs
                label={t('reviews.tabs')}
                value={tab}
                onChange={setTab}
                tabs={[
                  { value: 'pending', label: t('reviews.pending') },
                  { value: 'reviewed', label: t('reviews.reviewed') },
                ]}
              />
              <table className={tbl.table} aria-label={t(`reviews.${tab}`)}>
                <thead>
                  <tr>
                    <th>{t('fields.number')}</th>
                    <th>{t('fields.date')}</th>
                    <th>{t('fields.items')}</th>
                    <th className={tbl.num}>{t('fields.quantity')}</th>
                    {values && <th className={tbl.num}>{t('fields.value')}</th>}
                    <th>{t('reviews.postedBy')}</th>
                    {tab === 'reviewed' && <th>{t('reviews.reviewedBy')}</th>}
                    {tab === 'pending' && showAction && (
                      <th>
                        <span className={styles.visuallyHidden}>{t('reviews.mark')}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {docs.map((doc) => (
                    <OversellRow key={doc.id} doc={doc} tab={tab} onReview={setReviewing} />
                  ))}
                  {list.isLoading && (
                    <tr className={tbl.empty}>
                      <td colSpan={columns}>{t('loading')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {list.isError && <Alert>{errorText(list.error)}</Alert>}
            {list.isSuccess && docs.length === 0 && (
              <EmptyState>
                <CheckCircle2 className={styles.emptyIcon} aria-hidden="true" />
                <b>{tab === 'pending' ? t('reviews.emptyPending') : t('reviews.emptyReviewed')}</b>
                {tab === 'pending' && <span>{t('reviews.emptyPendingHint')}</span>}
              </EmptyState>
            )}
          </Card>
        </>
      )}
      {reviewing && <ReviewDialog doc={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}
