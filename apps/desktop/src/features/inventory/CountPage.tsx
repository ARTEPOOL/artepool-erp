import { useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Ban, CheckCircle2, Save, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type {
  CountDetail,
  CountLine,
  PostCountRequest,
  ReasonCodeItem,
  SaveCountLinesRequest,
} from '@artepool/shared/contracts';
import { newOperationKey } from '../../api/client';
import { useSave } from '../../api/hooks';
import { formatDate } from '../../lib/format';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Checkbox,
  cx,
  DefinitionList,
  Dialog,
  DialogFooter,
  EmptyState,
  iconClass,
  InfoBar,
  pageClasses,
  PageHeader,
  Segmented,
  tableClasses as tbl,
  useToast,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { ApprovalDialog } from '../masterdata/ApprovalDialog';
import { money } from '../masterdata/format';
import { localName, MD_KEYS, useReasonCodes, useUnits } from '../masterdata/refs';
import { quantityText } from '../items/form';
import { STOCK_INVALIDATE, STOCK_PATHS, useCount } from './api';
import { Progress } from './CountsPage';
import {
  CountStatusChip,
  quantityShort,
  readQuantity,
  ruleOf,
  SaveError,
  useUnitOf,
  type QuantityProblem,
} from './parts';
import styles from './inventory.module.css';

/** The API takes at most this many lines per save. */
const BATCH = 2000;

/** A signed difference with its colour class and sign (never colour alone). */
function Difference({ milli }: { milli: string | undefined }) {
  if (milli === undefined) return <span className={styles.even}>—</span>;
  const value = BigInt(milli);
  return (
    <bdi className={value > 0n ? styles.gain : value < 0n ? styles.loss : styles.even}>
      {quantityShort(value, true)}
    </bdi>
  );
}

/**
 * Counting (blind, decision 0044): each line gets its counted quantity; no system quantity is
 * shown. Enter moves to the next line. Save sends only the changed lines.
 */
function CountingView({ count }: { count: CountDetail }) {
  const { t, i18n } = useTranslation('inventory');
  const name = localName(i18n.language);
  const queryClient = useQueryClient();
  const toast = useToast();
  const units = useUnits();
  const unitOf = useUnitOf(units.data);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<string, QuantityProblem>>({});
  const [onlyOpen, setOnlyOpen] = useState(false);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  const save = useSave(
    async (a, body: SaveCountLinesRequest, key) => {
      let latest: CountDetail | null = null;
      for (let i = 0; i < body.lines.length; i += BATCH) {
        latest = await a.put<CountDetail>(
          STOCK_PATHS.countLines(count.id),
          { lines: body.lines.slice(i, i + BATCH) },
          // Saving the same counted numbers twice changes nothing, so later batches get fresh keys.
          { idempotencyKey: i === 0 ? key : newOperationKey() },
        );
      }
      return latest!;
    },
    {
      invalidate: [MD_KEYS.counts],
      onSuccess: (result) => {
        queryClient.setQueryData(MD_KEYS.count(count.id), result);
        setEdits({});
        toast(t('counts.count.saved'));
      },
    },
  );

  const shownValue = (line: CountLine) => edits[line.id] ?? quantityText(line.countedMilli);
  const changed = count.lines.filter(
    (l) => edits[l.id] !== undefined && edits[l.id]!.trim() !== quantityText(l.countedMilli),
  );
  const countedNow = count.lines.filter((l) => shownValue(l).trim() !== '').length;
  // "Not counted yet" keeps a line in view while it is being typed.
  const visible = onlyOpen
    ? count.lines.filter((l) => l.countedMilli === null || edits[l.id] !== undefined)
    : count.lines;

  const submit = () => {
    save.reset();
    const found: Record<string, QuantityProblem> = {};
    const lines: SaveCountLinesRequest['lines'] = [];
    for (const l of changed) {
      const text = edits[l.id]!.trim();
      if (!text) {
        lines.push({ lineId: l.id, countedMilli: null });
        continue;
      }
      const qty = readQuantity(text, unitOf(l.unitId).decimals, true);
      if (qty.ok) lines.push({ lineId: l.id, countedMilli: qty.value.toString() });
      else found[l.id] = qty.problem;
    }
    setProblems(found);
    if (Object.keys(found).length > 0 || lines.length === 0) return;
    save.mutate({ lines });
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const next = inputs.current[index + 1];
    if (next) {
      next.focus();
      next.select();
    } else submit();
  };

  return (
    <Card rise index={2} padding="table">
      <CardHeader title={t('counts.count.entry')}>
        <Progress done={countedNow} total={count.lineCount} />
      </CardHeader>
      <div className={styles.cardBody}>
        <InfoBar>{t('counts.count.blind')}</InfoBar>
        <div className={styles.toolbar}>
          <Checkbox isSelected={onlyOpen} onChange={setOnlyOpen}>
            {t('counts.count.onlyOpen')}
          </Checkbox>
          <span className={styles.muted}>
            {t('counts.count.changed', { count: changed.length })}
          </span>
        </div>
        <table className={tbl.table} aria-label={t('counts.count.lines')}>
          <thead>
            <tr>
              <th>{t('fields.code')}</th>
              <th>{t('fields.item')}</th>
              <th>{t('fields.unit')}</th>
              <th>{t('fields.counted')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((line, index) => {
              const unit = unitOf(line.unitId);
              const problem = problems[line.id];
              return (
                <tr key={line.id} className={cx(problem && styles.badRow)}>
                  <td>
                    <bdi>{line.itemCode}</bdi>
                  </td>
                  <td>
                    <b>{name(line)}</b>
                    {line.stockStatus === 'defective' && (
                      <span className={tbl.sub}>{t('counts.count.defective')}</span>
                    )}
                  </td>
                  <td>{unit.name}</td>
                  <td>
                    <input
                      ref={(el) => {
                        inputs.current[index] = el;
                      }}
                      className={cx(styles.cellInput, problem && styles.bad)}
                      dir="ltr"
                      inputMode="decimal"
                      enterKeyHint="next"
                      aria-label={t('counts.count.countedOf', { name: name(line) })}
                      aria-invalid={problem ? true : undefined}
                      value={shownValue(line)}
                      onChange={(event) =>
                        setEdits((all) => ({ ...all, [line.id]: event.target.value }))
                      }
                      onKeyDown={(event) => onKey(event, index)}
                    />
                    {problem && (
                      <span className={styles.fieldError}>
                        {t(`problems.${problem}`)}
                        {problem === 'decimals' && unit.decimals === 0 && ` ${t('problems.whole')}`}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {visible.length === 0 && <EmptyState>{t('counts.count.allCounted')}</EmptyState>}
        {Object.keys(problems).length > 0 && <Alert>{t('counts.count.fix')}</Alert>}
        {save.error !== null && <SaveError error={save.error} />}
        <div className={styles.actions}>
          <Button
            variant="primary"
            busy={save.isPending}
            isDisabled={changed.length === 0}
            onPress={submit}
          >
            <Save className={iconClass.sm} aria-hidden="true" />
            {t('counts.count.save')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

interface ReasonDraft {
  reasonCodeId: string;
  note: string;
}

/**
 * The review step (stock.count_post): system quantity, movements since the count started,
 * counted quantity and the difference. Every difference needs a reason before posting; a large
 * total needs a supervisor's approval (decision 0041).
 */
function ReviewView({ count }: { count: CountDetail }) {
  const { t, i18n } = useTranslation('inventory');
  const name = localName(i18n.language);
  const can = useCan();
  const queryClient = useQueryClient();
  const toast = useToast();
  const units = useUnits();
  const unitOf = useUnitOf(units.data);
  const reasonCodes = useReasonCodes();
  const values = can('stock.view_cost');
  const [drafts, setDrafts] = useState<Record<string, ReasonDraft>>(() =>
    Object.fromEntries(
      count.lines
        .filter((l) => l.reasonCodeId)
        .map((l) => [l.id, { reasonCodeId: l.reasonCodeId ?? '', note: l.note ?? '' }]),
    ),
  );
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const reasons: ReasonCodeItem[] = (reasonCodes.data ?? []).filter(
    (r) => r.category === 'stock_count' && r.isActive,
  );
  const differences = count.lines.filter(
    (l) => l.varianceMilli !== undefined && BigInt(l.varianceMilli) !== 0n,
  );
  const uncounted = count.lines.filter((l) => l.countedMilli === null).length;
  const totalFils = differences.reduce(
    (sum, l) => sum + (l.varianceFils !== undefined ? BigInt(l.varianceFils) : 0n),
    0n,
  );

  const post = useSave(
    (a, body: PostCountRequest, key) =>
      a.post<CountDetail>(STOCK_PATHS.countPost(count.id), body, { idempotencyKey: key }),
    {
      invalidate: STOCK_INVALIDATE,
      onSuccess: (result) => {
        queryClient.setQueryData(MD_KEYS.count(count.id), result);
        toast(t('counts.review.posted'));
      },
    },
  );
  const cancel = useSave(
    (a, body: { rowVersion: number }, key) =>
      a.post<CountDetail>(STOCK_PATHS.countCancel(count.id), body, { idempotencyKey: key }),
    {
      invalidate: STOCK_INVALIDATE,
      onSuccess: (result) => {
        queryClient.setQueryData(MD_KEYS.count(count.id), result);
        setCancelling(false);
        toast(t('counts.review.cancelled'));
      },
    },
  );

  const setDraft = (lineId: string, patch: Partial<ReasonDraft>) =>
    setDrafts((all) => ({
      ...all,
      [lineId]: { reasonCodeId: '', note: '', ...all[lineId], ...patch },
    }));

  const send = (approvalId?: string) => {
    post.reset();
    setProblem(null);
    if (uncounted > 0) return setProblem(t('counts.review.incomplete', { count: uncounted }));
    const lacking = new Set<string>();
    const body: PostCountRequest = { reasons: [], rowVersion: count.rowVersion };
    for (const l of differences) {
      const draft = drafts[l.id];
      const reason = reasons.find((r) => r.id === draft?.reasonCodeId);
      const note = draft?.note.trim() ?? '';
      if (!reason || (reason.requiresNote && !note)) {
        lacking.add(l.id);
        continue;
      }
      body.reasons.push({ lineId: l.id, reasonCodeId: reason.id, ...(note ? { note } : {}) });
    }
    setMissing(lacking);
    if (lacking.size > 0) return setProblem(t('counts.review.needReasons'));
    post.mutate(approvalId ? { ...body, approvalId } : body, {
      onError: (error) => {
        if (ruleOf(error) === 'APPROVAL_REQUIRED') setApproving(true);
      },
    });
  };

  const needsApproval = ruleOf(post.error) === 'APPROVAL_REQUIRED';
  const reload = () => {
    post.reset();
    cancel.reset();
    void queryClient.invalidateQueries({ queryKey: MD_KEYS.count(count.id) });
  };

  return (
    <Card rise index={2} padding="table">
      <CardHeader title={t('counts.review.title')}>
        <span className={styles.muted}>
          {t('counts.review.summary', { count: differences.length })}
        </span>
      </CardHeader>
      <div className={styles.cardBody}>
        <InfoBar>{t('counts.review.explain')}</InfoBar>
        <table className={tbl.table} aria-label={t('counts.review.lines')}>
          <thead>
            <tr>
              <th>{t('fields.item')}</th>
              <th className={tbl.num}>{t('fields.system')}</th>
              <th className={tbl.num}>{t('fields.movedSince')}</th>
              <th className={tbl.num}>{t('fields.counted')}</th>
              <th className={tbl.num}>{t('fields.difference')}</th>
              {values && <th className={tbl.num}>{t('fields.value')}</th>}
              <th>{t('fields.reason')}</th>
            </tr>
          </thead>
          <tbody>
            {count.lines.map((line) => {
              const unit = unitOf(line.unitId);
              const differs = line.varianceMilli !== undefined && BigInt(line.varianceMilli) !== 0n;
              const draft = drafts[line.id];
              const lacking = missing.has(line.id);
              const chosen = reasons.find((r) => r.id === draft?.reasonCodeId);
              return (
                <tr key={line.id} className={cx(lacking && styles.badRow)}>
                  <td>
                    <b>{name(line)}</b>
                    <span className={tbl.sub}>
                      <bdi>{line.itemCode}</bdi> · {unit.name}
                    </span>
                  </td>
                  <td className={tbl.num}>
                    <bdi>{line.systemMilli ? quantityShort(BigInt(line.systemMilli)) : '—'}</bdi>
                  </td>
                  <td className={tbl.num}>
                    <bdi>
                      {line.movedSinceMilli && BigInt(line.movedSinceMilli) !== 0n
                        ? quantityShort(BigInt(line.movedSinceMilli), true)
                        : '—'}
                    </bdi>
                  </td>
                  <td className={tbl.num}>
                    {line.countedMilli === null ? (
                      <span className={styles.muted}>{t('counts.review.notCounted')}</span>
                    ) : (
                      <bdi>{quantityShort(BigInt(line.countedMilli))}</bdi>
                    )}
                  </td>
                  <td className={tbl.num}>
                    <Difference
                      milli={line.countedMilli === null ? undefined : line.varianceMilli}
                    />
                  </td>
                  {values && (
                    <td className={tbl.num}>
                      <bdi>
                        {differs && line.varianceFils !== undefined
                          ? money(BigInt(line.varianceFils))
                          : '—'}
                      </bdi>
                    </td>
                  )}
                  <td>
                    {differs ? (
                      <div className={styles.reasonCell}>
                        <select
                          aria-label={t('counts.review.reasonOf', { name: name(line) })}
                          aria-invalid={lacking && !chosen ? true : undefined}
                          value={draft?.reasonCodeId ?? ''}
                          onChange={(event) =>
                            setDraft(line.id, { reasonCodeId: event.target.value })
                          }
                        >
                          <option value="">{t('counts.review.chooseReason')}</option>
                          {reasons.map((r) => (
                            <option key={r.id} value={r.id}>
                              {name(r)}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label={t('counts.review.noteOf', { name: name(line) })}
                          placeholder={
                            chosen?.requiresNote
                              ? t('counts.review.noteRequired')
                              : t('counts.review.noteOptional')
                          }
                          value={draft?.note ?? ''}
                          onChange={(event) => setDraft(line.id, { note: event.target.value })}
                        />
                        {lacking && (
                          <span className={styles.fieldError}>
                            {chosen
                              ? t('counts.review.noteMissing')
                              : t('counts.review.reasonMissing')}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className={styles.muted}>{t('counts.review.noDifference')}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {values && differences.length > 0 && (
          <div className={styles.totalRow}>
            <span>{t('counts.review.total')}</span>
            <b>
              <bdi>{money(totalFils)}</bdi>
            </b>
          </div>
        )}
        {problem && <Alert>{problem}</Alert>}
        {post.error !== null && !needsApproval && (
          <SaveError error={post.error} onReload={reload} />
        )}
        {needsApproval && !approving && <Alert tone="warn">{t('counts.review.approval')}</Alert>}
        {cancel.error !== null && !cancelling && (
          <SaveError error={cancel.error} onReload={reload} />
        )}
        <div className={styles.actions}>
          <Button variant="dangerGhost" onPress={() => setCancelling(true)}>
            <Ban className={iconClass.sm} aria-hidden="true" />
            {t('counts.review.cancel')}
          </Button>
          <Button variant="primary" busy={post.isPending} onPress={() => send()}>
            <Send className={iconClass.sm} aria-hidden="true" />
            {t('counts.review.post')}
          </Button>
        </div>
      </div>
      {approving && (
        <ApprovalDialog
          permission="stock.adjust_over_threshold"
          explanation={t('counts.review.approvalExplain')}
          context={{ countId: count.id }}
          onClose={() => setApproving(false)}
          onApproved={(approvalId) => {
            setApproving(false);
            send(approvalId);
          }}
        />
      )}
      {cancelling && (
        <Dialog isOpen onClose={() => setCancelling(false)} title={t('counts.review.cancelTitle')}>
          <div className={styles.form}>
            <p>{t('counts.review.cancelExplain')}</p>
            {cancel.error !== null && <SaveError error={cancel.error} onReload={reload} />}
            <DialogFooter>
              <Button onPress={() => setCancelling(false)}>{t('actions.keep')}</Button>
              <Button
                variant="danger"
                busy={cancel.isPending}
                onPress={() => cancel.mutate({ rowVersion: count.rowVersion })}
              >
                {t('counts.review.cancelConfirm')}
              </Button>
            </DialogFooter>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

/** A posted or cancelled count: read-only, with the differences when allowed. */
function ClosedView({ count }: { count: CountDetail }) {
  const { t, i18n } = useTranslation('inventory');
  const name = localName(i18n.language);
  const can = useCan();
  const units = useUnits();
  const unitOf = useUnitOf(units.data);
  const reasonCodes = useReasonCodes();
  const values = can('stock.view_cost') && count.review;
  const reasonName = (id: string | null) => {
    const reason = reasonCodes.data?.find((r) => r.id === id);
    return reason ? name(reason) : '';
  };
  return (
    <Card rise index={2} padding="table">
      <CardHeader title={t('counts.closed.title')} />
      <div className={styles.cardBody}>
        <table className={tbl.table} aria-label={t('counts.closed.lines')}>
          <thead>
            <tr>
              <th>{t('fields.item')}</th>
              <th className={tbl.num}>{t('fields.counted')}</th>
              {count.review && <th className={tbl.num}>{t('fields.difference')}</th>}
              {values && <th className={tbl.num}>{t('fields.value')}</th>}
              {count.review && <th>{t('fields.reason')}</th>}
            </tr>
          </thead>
          <tbody>
            {count.lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <b>{name(line)}</b>
                  <span className={tbl.sub}>
                    <bdi>{line.itemCode}</bdi> · {unitOf(line.unitId).name}
                  </span>
                </td>
                <td className={tbl.num}>
                  <bdi>
                    {line.countedMilli === null ? '—' : quantityShort(BigInt(line.countedMilli))}
                  </bdi>
                </td>
                {count.review && (
                  <td className={tbl.num}>
                    <Difference milli={line.varianceMilli} />
                  </td>
                )}
                {values && (
                  <td className={tbl.num}>
                    <bdi>{line.varianceFils ? money(BigInt(line.varianceFils)) : '—'}</bdi>
                  </td>
                )}
                {count.review && (
                  <td>
                    {reasonName(line.reasonCodeId)}
                    {line.note && <span className={tbl.sub}>{line.note}</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** One stock count: counting (blind), the review and posting, or the closed document. */
export function CountPage() {
  const { t } = useTranslation('inventory');
  const { countId } = useParams({ from: '/stock/counts/$countId' });
  const can = useCan();
  const errorText = useErrorText();
  const count = useCount(countId);
  const data = count.data;
  const ready = data !== undefined;
  const allCounted = ready && data.countedLines === data.lineCount;
  const [step, setStep] = useState<'count' | 'review' | null>(null);
  const shownStep = step ?? (allCounted ? 'review' : 'count');

  const back = (
    <Link to="/stock/counts" className={styles.backLink}>
      <ArrowLeft className={cx(iconClass.sm, styles.flip)} aria-hidden="true" />
      {t('counts.count.back')}
    </Link>
  );

  if (!ready) {
    return (
      <div className={pageClasses.page}>
        <PageHeader title={t('counts.count.title')} tools={back} />
        {count.isError ? (
          <Alert>{errorText(count.error)}</Alert>
        ) : (
          <EmptyState>{t('loading')}</EmptyState>
        )}
      </div>
    );
  }

  const open = data.status === 'counting' || data.status === 'draft';
  const reviewing = open && data.review && can('stock.count_post');
  return (
    <div className={pageClasses.page}>
      <PageHeader
        title={data.docNumber ? <bdi>{data.docNumber}</bdi> : t('counts.count.title')}
        subtitle={t(`counts.scopeLong.${data.scope}`)}
        tools={back}
      />
      <Card rise index={1}>
        <DefinitionList
          rows={[
            { label: t('fields.status'), value: <CountStatusChip status={data.status} /> },
            { label: t('counts.list.created'), value: <bdi>{formatDate(data.createdAt)}</bdi> },
            ...(data.countDate
              ? [{ label: t('fields.date'), value: <bdi>{formatDate(data.countDate)}</bdi> }]
              : []),
            {
              label: t('counts.list.progress'),
              value: <Progress done={data.countedLines} total={data.lineCount} />,
            },
            ...(data.note ? [{ label: t('fields.note'), value: data.note }] : []),
          ]}
        />
      </Card>
      {data.status === 'posted' && (
        <div role="status" className={styles.success}>
          <CheckCircle2 aria-hidden="true" />
          <span>
            {t('counts.closed.posted')} <bdi>{data.docNumber ?? '—'}</bdi>
          </span>
        </div>
      )}
      {open && reviewing && (
        <Segmented
          label={t('counts.count.step')}
          value={shownStep}
          onChange={setStep}
          options={[
            { value: 'count', label: t('counts.count.stepCount') },
            { value: 'review', label: t('counts.count.stepReview') },
          ]}
        />
      )}
      {open && (!reviewing || shownStep === 'count') && <CountingView count={data} />}
      {open && reviewing && shownStep === 'review' && (
        <ReviewView key={data.rowVersion} count={data} />
      )}
      {!open && <ClosedView count={data} />}
    </div>
  );
}
