/**
 * Writing an invoice draft (design 06): the customer (the format follows their VAT registration,
 * decision 0010), the lines with their discounts (0012), a discount on the total, earlier payments
 * to deduct (0013), and a live preview of VAT per line (0009). A draft has no number; it gets one
 * when it is issued (0011). Issuing needs the draft saved and unchanged.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Save, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { formatFils } from '@artepool/shared';
import type { DocumentDetail, SaveInvoiceRequest } from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import { formatDate } from '../../lib/format';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  DialogFooter,
  iconClass,
  InfoBar,
  TextField,
  useToast,
} from '../../ui';
import { useCan } from '../auth/context';
import { useCustomer } from '../customers/api';
import { SaveError } from '../inventory/parts';
import { money } from '../masterdata/format';
import { SALES_INVALIDATE, SALES_KEYS, SALES_PATHS, useDocuments } from '../sales/api';
import {
  chosenFrom,
  CustomerPicker,
  useWalkInCustomer,
  type ChosenCustomer,
} from '../sales/CustomerPicker';
import {
  LineEditor,
  PreviewTotals,
  TotalsBox,
  useLineRefs,
  useLinesPreview,
} from '../sales/LineEditor';
import { lineFromSaved, readDocDiscount, toRequest, type EditorLine } from '../sales/lines';
import salesStyles from '../sales/sales.module.css';
import { PrintButton } from './DocumentView';
import { IssueDialog } from './IssueDialog';
import { DateField, fieldErrorCode, lineErrorCodes } from './parts';
import styles from './invoices.module.css';

interface EditorState {
  customer: ChosenCustomer | null;
  dueDate: string;
  notes: string;
  docDiscount: string;
  lines: EditorLine[];
  deductions: string[];
}

function initialState(doc: DocumentDetail | null): EditorState {
  if (!doc) {
    return { customer: null, dueDate: '', notes: '', docDiscount: '', lines: [], deductions: [] };
  }
  const discount = BigInt(doc.docDiscountFils);
  return {
    customer: {
      id: doc.customerId,
      name: doc.billToName,
      phone: doc.billToPhone,
      trn: doc.billToTrn,
      isVatRegistered: doc.invoiceFormat === 'full',
    },
    dueDate: doc.dueDate ?? '',
    notes: doc.notes ?? '',
    docDiscount: discount === 0n ? '' : formatFils(discount),
    lines: doc.lines
      .filter((l) => l.lineKind === 'item')
      .map((l) => lineFromSaved(l, { nameAr: l.descriptionAr, nameEn: l.descriptionEn })),
    deductions: doc.lines
      .filter((l) => l.lineKind === 'advance_deduction' && l.advanceDocumentId)
      .map((l) => l.advanceDocumentId!),
  };
}

/** What decides whether the draft changed since it was saved (line keys are not content). */
const contentKey = (s: EditorState) =>
  JSON.stringify({
    customer: s.customer?.id ?? null,
    dueDate: s.dueDate,
    notes: s.notes.trim(),
    docDiscount: s.docDiscount.trim(),
    deductions: [...s.deductions].sort(),
    lines: s.lines.map((l) => [l.itemId, l.quantity, l.unitPrice, l.discountMode, l.discount]),
  });

export function DraftEditor({ doc }: { doc: DocumentDetail | null }) {
  const { t, i18n } = useTranslation('invoices');
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const refs = useLineRefs();
  const [state, setState] = useState<EditorState>(() => initialState(doc));
  const [savedKey] = useState<string | null>(() => (doc ? contentKey(initialState(doc)) : null));
  const [problem, setProblem] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const patch = (p: Partial<EditorState>) => setState((s) => ({ ...s, ...p }));

  // A new invoice starts with the cash customer; the person can pick another at once.
  const walkIn = useWalkInCustomer();
  const customerTouched = useRef(doc !== null);
  useEffect(() => {
    if (walkIn && !customerTouched.current) {
      customerTouched.current = true;
      setState((s) => (s.customer === null ? { ...s, customer: walkIn } : s));
    }
  }, [walkIn]);

  // The customer's VAT registration decides the format; a saved draft reads it from the customer.
  const customerDetail = useCustomer(
    doc && can('customers.view') && state.customer?.id === doc.customerId ? doc.customerId : null,
  );
  const customer =
    state.customer && customerDetail.data?.id === state.customer.id
      ? chosenFrom(customerDetail.data)
      : state.customer;

  const preview = useLinesPreview(state.lines, state.docDiscount);
  const discount = readDocDiscount(state.docDiscount);

  // Earlier payments of this customer with something left to deduct (decision 0013).
  const advancesQuery = useDocuments(
    { customerId: customer?.id, docType: 'advance_invoice', status: 'issued' },
    customer !== null,
  );
  const advances = useMemo(
    () =>
      (advancesQuery.data?.documents ?? []).filter(
        (a) => BigInt(a.advanceLeftNetFils ?? '0') > 0n || BigInt(a.advanceLeftVatFils ?? '0') > 0n,
      ),
    [advancesQuery.data],
  );
  const leftOf = (a: (typeof advances)[number]) =>
    BigInt(a.advanceLeftNetFils ?? '0') + BigInt(a.advanceLeftVatFils ?? '0');
  const deductedFils = advances
    .filter((a) => state.deductions.includes(a.id))
    .reduce((s, a) => s + leftOf(a), 0n);

  const dirty = savedKey === null || contentKey(state) !== savedKey;

  const save = useSave(
    (a, body: SaveInvoiceRequest, key) =>
      doc
        ? a.put<DocumentDetail>(SALES_PATHS.invoice(doc.id), body, { idempotencyKey: key })
        : a.post<DocumentDetail>(SALES_PATHS.invoices, body, { idempotencyKey: key }),
    {
      invalidate: SALES_INVALIDATE,
      onSuccess: (saved) => {
        queryClient.setQueryData(SALES_KEYS.document(saved.id), saved);
        toast(t('form.saved'));
        if (!doc) void navigate({ to: '/invoices/$documentId', params: { documentId: saved.id } });
      },
    },
  );

  const discard = useSave(
    (a, body: { rowVersion: number }, key) =>
      a.post<DocumentDetail>(SALES_PATHS.discard(doc!.id), body, { idempotencyKey: key }),
    {
      invalidate: SALES_INVALIDATE,
      onSuccess: () => {
        toast(t('form.discarded'));
        void navigate({ to: '/invoices' });
      },
    },
  );

  const submit = () => {
    setProblem(null);
    save.reset();
    if (!customer) return setProblem(t('form.problems.customer'));
    if (state.lines.length === 0) return setProblem(t('form.problems.lines'));
    const lines = toRequest(state.lines, refs.unitDecimalsOf);
    if (!lines) return setProblem(t('form.problems.lineValues'));
    if (discount === null || (discount > 0n && !preview.complete))
      return setProblem(t('form.problems.discount'));
    const notes = state.notes.trim();
    save.mutate({
      customerId: customer.id,
      ...(state.dueDate ? { dueDate: state.dueDate } : {}),
      ...(notes ? { notes } : {}),
      ...(discount > 0n ? { docDiscountFils: discount.toString() } : {}),
      lines,
      ...(state.deductions.length > 0
        ? { deductions: state.deductions.map((advanceDocumentId) => ({ advanceDocumentId })) }
        : {}),
      ...(doc ? { rowVersion: doc.rowVersion } : {}),
    });
  };

  const lineCodes = lineErrorCodes(save.error);
  const lineErrors = Object.fromEntries(
    Object.entries(lineCodes).map(([index, code]) => [
      index,
      i18n.exists(`invoices:form.lineErrors.${code}`)
        ? t(`form.lineErrors.${code}`)
        : t('form.lineErrors.other'),
    ]),
  );
  const discountError = fieldErrorCode(save.error, 'docDiscountFils');
  const showSaveError =
    save.error !== null && Object.keys(lineCodes).length === 0 && !discountError;

  return (
    <>
      <Card rise index={1}>
        <CardHeader title={t('sales:fields.customer')} />
        <div className={salesStyles.cardBody}>
          <CustomerPicker
            value={customer}
            onChange={(c) => {
              customerTouched.current = true;
              patch({ customer: c, deductions: [] });
            }}
            showBalance
          />
          {customer && (
            <InfoBar>
              {t(
                customer.isVatRegistered ? 'sales:formatHint.full' : 'sales:formatHint.simplified',
              )}
            </InfoBar>
          )}
        </div>
      </Card>

      <Card rise index={2}>
        <CardHeader title={t('sales:lines.title')} />
        <div className={salesStyles.cardBody}>
          <LineEditor
            lines={state.lines}
            onChange={(lines) => patch({ lines })}
            docDiscount={state.docDiscount}
            lineErrors={lineErrors}
          />
        </div>
      </Card>

      {customer && advances.length > 0 && (
        <Card rise index={3}>
          <CardHeader title={t('form.advances.title')} />
          <div className={salesStyles.cardBody}>
            <p className={salesStyles.muted}>{t('form.advances.explain')}</p>
            <ul className={styles.advances} aria-label={t('form.advances.title')}>
              {advances.map((a) => (
                <li key={a.id}>
                  <Checkbox
                    isSelected={state.deductions.includes(a.id)}
                    onChange={(on) =>
                      patch({
                        deductions: on
                          ? [...state.deductions, a.id]
                          : state.deductions.filter((id) => id !== a.id),
                      })
                    }
                  >
                    {t('form.advances.deduct', { number: a.docNumber ?? '' })}
                  </Checkbox>
                  <span className={salesStyles.muted}>
                    {a.issueDate && <bdi>{formatDate(a.issueDate)}</bdi>}{' '}
                    {t('form.advances.left', { amount: money(leftOf(a)) })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      <Card rise index={4}>
        <div className={salesStyles.cardBody}>
          <div className={styles.columns}>
            <div className={salesStyles.form}>
              <DateField
                label={t('form.dueDate')}
                value={state.dueDate}
                onChange={(dueDate) => patch({ dueDate })}
              />
              <TextField
                label={t('sales:totals.docDiscount')}
                value={state.docDiscount}
                onChange={(docDiscount) => patch({ docDiscount })}
                ltr
                inputMode="numeric"
                hint={t('form.docDiscountHint')}
                error={
                  discount === null || discountError
                    ? t('form.problems.discount')
                    : discount > 0n && !preview.complete
                      ? t('form.problems.discount')
                      : undefined
                }
              />
              <TextField
                label={t('sales:fields.notes')}
                value={state.notes}
                onChange={(notes) => patch({ notes })}
                multiline
              />
            </div>
            <div className={salesStyles.form}>
              <PreviewTotals preview={preview} />
              {deductedFils > 0n && (
                <TotalsBox
                  rows={[
                    { label: t('sales:totals.deductions'), fils: -deductedFils },
                    {
                      label: t('sales:totals.due'),
                      fils: preview.totalFils - deductedFils,
                      strong: true,
                    },
                  ]}
                />
              )}
            </div>
          </div>
          {problem && <InfoBar>{problem}</InfoBar>}
          {showSaveError && (
            <SaveError
              error={save.error}
              onReload={
                doc
                  ? () =>
                      void queryClient.invalidateQueries({ queryKey: SALES_KEYS.document(doc.id) })
                  : undefined
              }
            />
          )}
          {doc && !dirty && !can('invoices.issue') && <InfoBar>{t('form.cannotIssue')}</InfoBar>}
          {doc && dirty && <p className={salesStyles.muted}>{t('form.saveFirst')}</p>}
          <div className={salesStyles.actions}>
            {doc && (
              <Button variant="dangerGhost" onPress={() => setDiscarding(true)}>
                <Ban className={iconClass.sm} aria-hidden="true" />
                {t('form.discard')}
              </Button>
            )}
            {doc && <PrintButton doc={doc} />}
            <Button busy={save.isPending} onPress={submit}>
              <Save className={iconClass.sm} aria-hidden="true" />
              {t('form.save')}
            </Button>
            {can('invoices.issue') && (
              <Button variant="primary" isDisabled={!doc || dirty} onPress={() => setIssuing(true)}>
                <Send className={iconClass.sm} aria-hidden="true" />
                {t('form.issue')}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {discarding && doc && (
        <Dialog isOpen onClose={() => setDiscarding(false)} title={t('form.discardTitle')}>
          <div className={salesStyles.form}>
            <p>{t('form.discardExplain')}</p>
            {discard.error !== null && <SaveError error={discard.error} />}
            <DialogFooter>
              <Button onPress={() => setDiscarding(false)}>{t('form.keep')}</Button>
              <Button
                variant="danger"
                busy={discard.isPending}
                onPress={() => discard.mutate({ rowVersion: doc.rowVersion })}
              >
                {t('form.discardConfirm')}
              </Button>
            </DialogFooter>
          </div>
        </Dialog>
      )}
      {issuing && doc && (
        <IssueDialog
          doc={doc}
          onClose={() => setIssuing(false)}
          onIssued={(issued) => {
            setIssuing(false);
            toast(t('issue.done', { number: issued.docNumber ?? '' }));
          }}
        />
      )}
    </>
  );
}
