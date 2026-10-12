/**
 * One quotation (decision 0049): a new one (`new`), a draft being edited, or a sent quotation
 * with its revisions. A draft is edited freely; sending fixes its prices (a changed price or a
 * discount above the limit needs a supervisor's approval then). A sent quotation changes only
 * through a new revision; converting makes an invoice draft at the quotation's prices.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Ban,
  CalendarX,
  CheckCircle2,
  FileOutput,
  FilePlus2,
  Lock,
  Printer,
  Save,
  Send,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { formatFils, formatQuantity } from '@artepool/shared';
import type {
  DocumentDetail,
  QuotationActionRequest,
  QuotationDetail,
  SaveQuotationRequest,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../api/hooks';
import { dubaiDay, formatDate } from '../../lib/format';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Chip,
  cx,
  DefinitionList,
  Dialog,
  DialogFooter,
  EmptyState,
  iconClass,
  InfoBar,
  pageClasses,
  PageHeader,
  tableClasses as tbl,
  TextField,
  useToast,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { ruleOf, SaveError } from '../inventory/parts';
import { ApprovalDialog } from '../masterdata/ApprovalDialog';
import { money, price } from '../masterdata/format';
import { fetchPdf, SALES_INVALIDATE, SALES_KEYS, SALES_PATHS, useQuotation } from '../sales/api';
import { CustomerPicker, type ChosenCustomer } from '../sales/CustomerPicker';
import {
  LineEditor,
  PreviewTotals,
  TotalsBox,
  useLineRefs,
  useLinesPreview,
} from '../sales/LineEditor';
import { readDocDiscount, toRequest, type EditorLine } from '../sales/lines';
import { printPdf } from '../sales/print';
import salesStyles from '../sales/sales.module.css';
import {
  editorLinesOf,
  lineIssues,
  QuotationStatusChip,
  quotationNumber,
  revisionRequest,
  validityOf,
  ValidityChip,
} from './parts';
import styles from './quotations.module.css';

type Action = QuotationActionRequest['action'];
type Step = Action | 'revise' | 'convert';
type ApprovalKind = 'sales.price_override' | 'sales.discount_over_limit';

/** What each rule of a refused send needs a supervisor to approve. */
const APPROVAL_FOR_RULE: Record<string, ApprovalKind> = {
  PRICE_OVERRIDE: 'sales.price_override',
  DISCOUNT_OVER_LIMIT: 'sales.discount_over_limit',
};

/** "2.500" → "2.5". */
const quantityShort = (milli: string) => formatQuantity(BigInt(milli)).replace(/\.?0+$/, '') || '0';

const customerOf = (q: QuotationDetail): ChosenCustomer => ({
  id: q.customerId,
  name: q.customerName,
  phone: null,
  trn: q.billToTrn,
  isVatRegistered: q.billToTrn !== null,
});

// ---------------------------------------------------------------------------------------------
// The editor (new or draft)
// ---------------------------------------------------------------------------------------------

function DateInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
}) {
  return (
    <label className={styles.dateField}>
      <span>{props.label}</span>
      <input
        type="date"
        dir="ltr"
        value={props.value}
        aria-invalid={props.error ? true : undefined}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.hint && <span className={styles.hint}>{props.hint}</span>}
      {props.error && <span className={salesStyles.fieldError}>{props.error}</span>}
    </label>
  );
}

function QuotationEditor(props: {
  quotation: QuotationDetail | null;
  onDirty: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation('quotations');
  const q = props.quotation;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const refs = useLineRefs();
  const [customer, setCustomer] = useState<ChosenCustomer | null>(q ? customerOf(q) : null);
  const [date, setDate] = useState(q?.quotationDate ?? dubaiDay());
  const [validUntil, setValidUntil] = useState(q?.validUntil ?? '');
  const [subject, setSubject] = useState(q?.subject ?? '');
  const [termsAr, setTermsAr] = useState(q?.termsAr ?? '');
  const [termsEn, setTermsEn] = useState(q?.termsEn ?? '');
  const [notes, setNotes] = useState(q?.notes ?? '');
  const [lines, setLines] = useState<EditorLine[]>(() => (q ? editorLinesOf(q) : []));
  const [docDiscount, setDocDiscount] = useState(
    q && BigInt(q.docDiscountFils) > 0n ? formatFils(BigInt(q.docDiscountFils)) : '',
  );
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldProblems, setFieldProblems] = useState<{ validUntil?: string; discount?: string }>(
    {},
  );
  const previewed = useLinesPreview(lines, docDiscount);

  const { onDirty } = props;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setDirty(true);
    };

  const save = useSave(
    (a, body: SaveQuotationRequest, key) =>
      q
        ? a.put<QuotationDetail>(SALES_PATHS.quotation(q.id), body, { idempotencyKey: key })
        : a.post<QuotationDetail>(SALES_PATHS.quotations, body, { idempotencyKey: key }),
    {
      invalidate: SALES_INVALIDATE,
      onSuccess: (result) => {
        queryClient.setQueryData(SALES_KEYS.quotation(result.id), result);
        setDirty(false);
        toast(t('editor.saved', { number: quotationNumber(result) }));
        if (!q)
          void navigate({ to: '/quotations/$quotationId', params: { quotationId: result.id } });
      },
    },
  );

  const issues = lineIssues(save.error);
  const lineErrors = Object.fromEntries(
    Object.entries(issues).map(([index, code]) => [
      Number(index),
      i18n.exists(`quotations:lineErrors.${code}`)
        ? t(`lineErrors.${code}`)
        : t('lineErrors.invalid'),
    ]),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.reset();
    setProblem(null);
    const found: typeof fieldProblems = {};
    const discountFils = readDocDiscount(docDiscount);
    if (discountFils === null) found.discount = t('editor.badDiscount');
    if (validUntil && date && validUntil < date) found.validUntil = t('editor.badValidUntil');
    setFieldProblems(found);
    if (!customer) return setProblem(t('editor.needCustomer'));
    if (lines.length === 0) return setProblem(t('editor.needLines'));
    const request = toRequest(lines, refs.unitDecimalsOf);
    if (request === null) return setProblem(t('editor.fixLines'));
    if (Object.keys(found).length > 0 || discountFils === null) return;
    save.mutate({
      customerId: customer.id,
      ...(q ? { businessLineId: q.businessLineId } : {}),
      ...(date ? { quotationDate: date } : {}),
      ...(validUntil ? { validUntil } : {}),
      ...(subject.trim() ? { subject: subject.trim() } : {}),
      ...(termsAr.trim() ? { termsAr: termsAr.trim() } : {}),
      ...(termsEn.trim() ? { termsEn: termsEn.trim() } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(discountFils > 0n ? { docDiscountFils: discountFils.toString() } : {}),
      lines: request,
      ...(q ? { rowVersion: q.rowVersion } : {}),
    });
  };

  const reload = () => void queryClient.invalidateQueries({ queryKey: SALES_KEYS.all });

  return (
    <form onSubmit={submit} noValidate className={pageClasses.page}>
      <Card rise index={1}>
        <CardHeader title={t('editor.customerTitle')} />
        <div className={salesStyles.cardBody}>
          <CustomerPicker value={customer} onChange={edit(setCustomer)} />
        </div>
      </Card>
      <Card rise index={2}>
        <CardHeader title={t('editor.detailsTitle')} />
        <div className={cx(salesStyles.cardBody, styles.fields)}>
          <DateInput label={t('fields.quotationDate')} value={date} onChange={edit(setDate)} />
          <DateInput
            label={t('fields.validUntil')}
            value={validUntil}
            onChange={edit(setValidUntil)}
            hint={t('editor.validHint')}
            error={fieldProblems.validUntil}
          />
          <TextField
            label={t('fields.subject')}
            value={subject}
            onChange={edit(setSubject)}
            maxLength={300}
          />
        </div>
      </Card>
      <Card rise index={3}>
        <CardHeader title={t('sales:lines.title')} />
        <div className={salesStyles.cardBody}>
          <InfoBar>{t('editor.optionalHint')}</InfoBar>
          <LineEditor
            lines={lines}
            onChange={edit(setLines)}
            allowOptional
            docDiscount={docDiscount}
            lineErrors={lineErrors}
          />
          <div className={styles.discountRow}>
            <TextField
              className={styles.discountField}
              label={t('sales:totals.docDiscount')}
              value={docDiscount}
              onChange={edit(setDocDiscount)}
              inputMode="numeric"
              ltr
              placeholder="0.00"
              error={fieldProblems.discount}
            />
            <PreviewTotals preview={previewed} />
          </div>
        </div>
      </Card>
      <Card rise index={4}>
        <CardHeader title={t('editor.textsTitle')} />
        <div className={cx(salesStyles.cardBody, styles.texts)}>
          <TextField
            label={t('fields.termsAr')}
            value={termsAr}
            onChange={edit(setTermsAr)}
            multiline
            maxLength={4000}
          />
          <TextField
            label={t('fields.termsEn')}
            value={termsEn}
            onChange={edit(setTermsEn)}
            multiline
            ltr
            maxLength={4000}
          />
          <TextField
            label={t('sales:fields.notes')}
            value={notes}
            onChange={edit(setNotes)}
            multiline
            maxLength={2000}
            hint={t('editor.notesHint')}
          />
        </div>
      </Card>
      {problem && <Alert>{problem}</Alert>}
      {save.error !== null && Object.keys(issues).length === 0 && (
        <SaveError error={save.error} onReload={reload} />
      )}
      {Object.keys(issues).length > 0 && <Alert>{t('editor.fixLines')}</Alert>}
      <div className={styles.footer}>
        {dirty && <span className={styles.actionsNote}>{t('editor.unsaved')}</span>}
        <Button type="submit" variant="primary" busy={save.isPending}>
          <Save className={iconClass.sm} aria-hidden="true" />
          {q ? t('editor.save') : t('editor.create')}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// A saved quotation, read-only
// ---------------------------------------------------------------------------------------------

function QuotationLines({ quotation }: { quotation: QuotationDetail }) {
  const { t, i18n } = useTranslation('quotations');
  const refs = useLineRefs();
  const lines = quotation.lines;
  const hasOptional = lines.some((l) => l.isOptional);
  const discount = BigInt(quotation.discountTotalFils);
  const paid = BigInt(quotation.paymentsFils);
  return (
    <Card rise index={2} padding="table">
      <CardHeader title={t('sales:lines.title')} />
      <div className={salesStyles.cardBody}>
        <div className={salesStyles.tableWrap}>
          <table className={tbl.table} aria-label={t('sales:lines.title')}>
            <thead>
              <tr>
                <th>{t('sales:lines.item')}</th>
                <th className={tbl.num}>{t('sales:lines.quantity')}</th>
                <th className={tbl.num}>{t('sales:lines.unitPrice')}</th>
                <th className={tbl.num}>{t('sales:lines.discount')}</th>
                <th className={tbl.num}>{t('sales:lines.net')}</th>
                <th className={tbl.num}>{t('sales:lines.vat')}</th>
                <th className={tbl.num}>{t('sales:lines.lineTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const lineDiscount = BigInt(l.lineDiscountFils) + BigInt(l.docDiscountAllocFils);
                return (
                  <tr key={l.id} className={cx(l.isOptional && styles.optionalRow)}>
                    <td>
                      <span className={styles.lineName}>
                        <span>{i18n.language === 'ar' ? l.descriptionAr : l.descriptionEn}</span>
                        {l.isOptional && <Chip tone="info">{t('sales:lines.optional')}</Chip>}
                      </span>
                      <span className={tbl.sub}>
                        <bdi>{l.itemCode}</bdi>
                      </span>
                    </td>
                    <td className={tbl.num}>
                      <bdi>{quantityShort(l.quantityMilli)}</bdi>{' '}
                      <span className={salesStyles.muted}>
                        {l.unitId ? refs.unitName(l.unitId, i18n.language) : ''}
                      </span>
                    </td>
                    <td className={tbl.num}>
                      <bdi>{price(BigInt(l.unitPrice4dp))}</bdi>
                    </td>
                    <td className={tbl.num}>
                      <bdi>{lineDiscount > 0n ? money(lineDiscount) : '—'}</bdi>
                    </td>
                    <td className={tbl.num}>
                      <bdi>{money(BigInt(l.netFils))}</bdi>
                    </td>
                    <td className={tbl.num}>
                      <bdi>{money(BigInt(l.vatFils))}</bdi>
                    </td>
                    <td className={tbl.num}>
                      <bdi>{money(BigInt(l.grossFils))}</bdi>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <TotalsBox
          rows={[
            ...(discount > 0n ? [{ label: t('sales:totals.discount'), fils: discount }] : []),
            { label: t('sales:totals.net'), fils: BigInt(quotation.netFils) },
            { label: t('sales:totals.vat'), fils: BigInt(quotation.vatFils) },
            { label: t('sales:totals.total'), fils: BigInt(quotation.totalFils), strong: true },
            ...(paid > 0n ? [{ label: t('view.paymentsReceived'), fils: paid }] : []),
          ]}
          note={hasOptional ? t('view.optionalNote') : undefined}
        />
      </div>
    </Card>
  );
}

function QuotationTexts({ quotation }: { quotation: QuotationDetail }) {
  const { t } = useTranslation('quotations');
  const texts = [
    { label: t('fields.termsAr'), text: quotation.termsAr, dir: 'rtl' as const },
    { label: t('fields.termsEn'), text: quotation.termsEn, dir: 'ltr' as const },
    { label: t('sales:fields.notes'), text: quotation.notes, dir: undefined },
  ].filter((x) => x.text);
  if (texts.length === 0) return null;
  return (
    <Card rise index={3}>
      <CardHeader title={t('editor.textsTitle')} />
      <div className={cx(salesStyles.cardBody, styles.texts)}>
        {texts.map((x) => (
          <section key={x.label}>
            <h3>{x.label}</h3>
            <p dir={x.dir}>{x.text}</p>
          </section>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The facts, the revisions and the actions of a saved quotation
// ---------------------------------------------------------------------------------------------

function QuotationFacts({ quotation }: { quotation: QuotationDetail }) {
  const { t } = useTranslation('quotations');
  const validity = validityOf(quotation, dubaiDay());
  return (
    <Card rise index={1}>
      <DefinitionList
        rows={[
          {
            label: t('sales:fields.status'),
            value: <QuotationStatusChip status={quotation.status} />,
          },
          {
            label: t('sales:fields.customer'),
            value: (
              <>
                {quotation.billToName}
                {quotation.billToTrn && (
                  <span className={tbl.sub}>
                    {t('sales:customerPicker.trn', { trn: quotation.billToTrn })}
                  </span>
                )}
              </>
            ),
          },
          {
            label: t('fields.quotationDate'),
            value: <bdi>{formatDate(quotation.quotationDate)}</bdi>,
          },
          {
            label: t('fields.validUntil'),
            value: (
              <span className={styles.validCell}>
                <bdi>{formatDate(quotation.validUntil)}</bdi>
                <ValidityChip validity={validity} />
              </span>
            ),
          },
          ...(quotation.subject ? [{ label: t('fields.subject'), value: quotation.subject }] : []),
          { label: t('fields.revision'), value: <bdi>{quotation.revision}</bdi> },
          ...(quotation.convertedDocumentId
            ? [
                {
                  label: t('view.invoice'),
                  value: (
                    <Link
                      className={styles.link}
                      to="/invoices/$documentId"
                      params={{ documentId: quotation.convertedDocumentId }}
                    >
                      {t('view.openInvoice')}
                    </Link>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Card>
  );
}

function Revisions({ quotation }: { quotation: QuotationDetail }) {
  const { t } = useTranslation('quotations');
  if (quotation.revisions.length < 2) return null;
  return (
    <Card rise index={4}>
      <CardHeader title={t('revisions.title')} />
      <div className={salesStyles.cardBody}>
        <ul className={styles.revisions} aria-label={t('revisions.title')}>
          {quotation.revisions.map((r) => (
            <li key={r.id}>
              {r.id === quotation.id ? (
                <span className={styles.current} aria-current="page">
                  {t('revisions.revision', { number: r.revision })} · {t('revisions.current')}
                </span>
              ) : (
                <Link
                  className={styles.link}
                  to="/quotations/$quotationId"
                  params={{ quotationId: r.id }}
                >
                  {t('revisions.revision', { number: r.revision })}
                </Link>
              )}
              <QuotationStatusChip status={r.status} />
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

const STEP_ICON: Record<Step, typeof Send> = {
  send: Send,
  accept: CheckCircle2,
  reject: XCircle,
  cancel: Ban,
  expire: CalendarX,
  revise: FilePlus2,
  convert: FileOutput,
};

/** Refusing steps look dangerous; sending and converting are the main step. */
const stepVariant = (s: Step) =>
  s === 'send' || s === 'convert'
    ? ('primary' as const)
    : s === 'cancel' || s === 'reject'
      ? ('dangerGhost' as const)
      : ('default' as const);

function QuotationActions(props: { quotation: QuotationDetail; dirty: boolean }) {
  const { t } = useTranslation('quotations');
  const q = props.quotation;
  const can = useCan();
  const api = useApi();
  const errorText = useErrorText();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const refs = useLineRefs();
  const [step, setStep] = useState<Step | null>(null);
  const [approval, setApproval] = useState<ApprovalKind | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<unknown>(null);

  const act = useSave(
    (a, body: QuotationActionRequest & { approvalId?: string; priceApprovalId?: string }, key) =>
      a.post<QuotationDetail>(SALES_PATHS.quotationAction(q.id), body, { idempotencyKey: key }),
    {
      invalidate: SALES_INVALIDATE,
      onSuccess: (result, body) => {
        queryClient.setQueryData(SALES_KEYS.quotation(result.id), result);
        setStep(null);
        toast(t(`done.${body.action}`));
      },
    },
  );
  const revise = useSave(
    (a, body: SaveQuotationRequest, key) =>
      a.post<QuotationDetail>(SALES_PATHS.quotationRevise(q.id), body, { idempotencyKey: key }),
    {
      invalidate: SALES_INVALIDATE,
      onSuccess: (result) => {
        queryClient.setQueryData(SALES_KEYS.quotation(result.id), result);
        setStep(null);
        toast(t('done.revise', { number: quotationNumber(result) }));
        void navigate({ to: '/quotations/$quotationId', params: { quotationId: result.id } });
      },
    },
  );
  const convert = useSave(
    (a, body: { rowVersion: number }, key) =>
      a.post<DocumentDetail>(SALES_PATHS.quotationConvert(q.id), body, { idempotencyKey: key }),
    {
      invalidate: SALES_INVALIDATE,
      onSuccess: (result) => {
        setStep(null);
        toast(t('done.convert'));
        void navigate({ to: '/invoices/$documentId', params: { documentId: result.id } });
      },
    },
  );

  const reload = () => void queryClient.invalidateQueries({ queryKey: SALES_KEYS.all });
  const expiredByDate = q.validUntil < dubaiDay();
  const canConvert = can('invoices.create');

  const available: Step[] =
    q.status === 'draft'
      ? ['send', 'cancel']
      : q.status === 'sent'
        ? [
            'accept',
            'reject',
            'revise',
            ...(canConvert ? (['convert'] as const) : []),
            ...(expiredByDate ? (['expire'] as const) : []),
            'cancel',
          ]
        : q.status === 'accepted'
          ? [...(canConvert ? (['convert'] as const) : []), 'cancel']
          : [];

  // A discount above the limit and changed prices each need their own approval.
  const [given, setGiven] = useState<{ approvalId?: string; priceApprovalId?: string }>({});
  const sendAction = (action: Action, approvals: typeof given = {}) => {
    act.mutate(
      { action, rowVersion: q.rowVersion, ...(action === 'send' ? approvals : {}) },
      {
        onError: (error) => {
          const needed = action === 'send' ? APPROVAL_FOR_RULE[ruleOf(error) ?? ''] : undefined;
          const already =
            needed === 'sales.price_override' ? approvals.priceApprovalId : approvals.approvalId;
          if (needed && !already) {
            setStep(null);
            setApproval(needed);
          }
        },
      },
    );
  };

  // The revision needs the units to read the lines; until then (or if a line no longer fits its
  // unit) the confirm button waits and says why.
  const revisionBody =
    step === 'revise' && refs.ready ? revisionRequest(q, refs.unitDecimalsOf) : null;
  const confirm = () => {
    if (step === null) return;
    if (step === 'revise') {
      if (revisionBody) revise.mutate(revisionBody);
      return;
    }
    if (step === 'convert') return convert.mutate({ rowVersion: q.rowVersion });
    sendAction(step, given);
  };

  const print = async () => {
    setPrinting(true);
    setPrintError(null);
    try {
      await printPdf(await fetchPdf(api, SALES_PATHS.quotationPdf(q.id)));
    } catch (error) {
      setPrintError(error);
    } finally {
      setPrinting(false);
    }
  };

  const open = (next: Step) => {
    act.reset();
    revise.reset();
    convert.reset();
    setStep(next);
  };

  const stepError =
    step === 'revise' ? revise.error : step === 'convert' ? convert.error : act.error;
  const busy = act.isPending || revise.isPending || convert.isPending;

  return (
    <Card rise index={5}>
      <CardHeader title={t('actions.title')} />
      <div className={salesStyles.cardBody}>
        {q.status === 'draft' && <p className={styles.actionsNote}>{t('actions.sendNote')}</p>}
        {(q.status === 'sent' || q.status === 'accepted') && canConvert && (
          <p className={styles.actionsNote}>{t('actions.convertNote')}</p>
        )}
        {props.dirty && <Alert tone="warn">{t('actions.saveFirst')}</Alert>}
        {step === null && approval === null && act.error !== null && (
          <SaveError error={act.error} onReload={reload} />
        )}
        {printError !== null && <Alert>{errorText(printError)}</Alert>}
        <div className={salesStyles.actions}>
          {available.map((s) => {
            const Icon = STEP_ICON[s];
            return (
              <Button
                key={s}
                variant={stepVariant(s)}
                isDisabled={props.dirty}
                onPress={() => open(s)}
              >
                <Icon className={iconClass.sm} aria-hidden="true" />
                {t(`actions.${s}`)}
              </Button>
            );
          })}
          <Button busy={printing} isDisabled={props.dirty} onPress={() => void print()}>
            <Printer className={iconClass.sm} aria-hidden="true" />
            {q.status === 'draft' ? t('actions.printDraft') : t('sales:print.print')}
          </Button>
        </div>
      </div>
      {step !== null && (
        <Dialog isOpen onClose={() => setStep(null)} title={t(`confirm.${step}.title`)}>
          <div className={salesStyles.form}>
            <p>{t(`confirm.${step}.text`, { number: quotationNumber(q), next: q.revision + 1 })}</p>
            {step === 'convert' && <InfoBar>{t('actions.convertNote')}</InfoBar>}
            {step === 'revise' && revisionBody === null && (
              <p className={salesStyles.muted}>{t('actions.cannotRevise')}</p>
            )}
            {stepError !== null && <SaveError error={stepError} onReload={reload} />}
            <DialogFooter>
              <Button onPress={() => setStep(null)}>{t('confirm.back')}</Button>
              <Button
                variant={step === 'cancel' || step === 'reject' ? 'danger' : 'primary'}
                busy={busy}
                isDisabled={step === 'revise' && revisionBody === null}
                onPress={confirm}
              >
                {t(`confirm.${step}.confirm`)}
              </Button>
            </DialogFooter>
          </div>
        </Dialog>
      )}
      {approval !== null && (
        <ApprovalDialog
          permission={approval}
          title={
            approval === 'sales.price_override'
              ? t('sales:approval.priceTitle')
              : t('sales:approval.discountTitle')
          }
          explanation={
            approval === 'sales.price_override'
              ? t('sales:approval.priceExplain')
              : t('sales:approval.discountExplain')
          }
          subject={<bdi>{quotationNumber(q)}</bdi>}
          context={{ action: 'quotation_send', quotationId: q.id }}
          onClose={() => setApproval(null)}
          onApproved={(approvalId) => {
            const next =
              approval === 'sales.price_override'
                ? { ...given, priceApprovalId: approvalId }
                : { ...given, approvalId };
            setApproval(null);
            setGiven(next);
            sendAction('send', next);
          }}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

export function QuotationPage() {
  const { t } = useTranslation('quotations');
  const can = useCan();
  const errorText = useErrorText();
  const { quotationId } = useParams({ from: '/quotations/$quotationId' });
  const allowed = can('quotations.manage');
  const isNew = quotationId === 'new';
  const query = useQuotation(allowed && !isNew ? quotationId : null);
  const data = query.data;
  const [dirty, setDirty] = useState(false);

  const back = (
    <Link to="/quotations" className={styles.backLink}>
      <ArrowLeft className={cx(iconClass.sm, styles.flip)} aria-hidden="true" />
      {t('back')}
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
        <PageHeader title={t('editor.newTitle')} subtitle={t('editor.newSubtitle')} tools={back} />
        <QuotationEditor key="new" quotation={null} onDirty={setDirty} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className={pageClasses.page}>
        <PageHeader title={t('title')} tools={back} />
        {query.isError ? (
          <Alert>{errorText(query.error)}</Alert>
        ) : (
          <EmptyState>{t('sales:loading')}</EmptyState>
        )}
      </div>
    );
  }

  const title = (
    <>
      {t('view.title')} <bdi>{quotationNumber(data)}</bdi>
    </>
  );
  const subtitle = (
    <span className={styles.headerFacts}>
      <QuotationStatusChip status={data.status} />
      <span>{data.customerName}</span>
    </span>
  );

  return (
    <div className={pageClasses.page}>
      <PageHeader title={title} subtitle={subtitle} tools={back} />
      {data.status === 'draft' ? (
        <QuotationEditor
          key={`editor-${data.id}-${data.rowVersion}`}
          quotation={data}
          onDirty={setDirty}
        />
      ) : (
        <>
          <QuotationFacts quotation={data} />
          <QuotationLines quotation={data} />
          <QuotationTexts quotation={data} />
        </>
      )}
      <Revisions quotation={data} />
      <QuotationActions
        key={`actions-${data.id}-${data.rowVersion}`}
        quotation={data}
        dirty={data.status === 'draft' && dirty}
      />
    </div>
  );
}
