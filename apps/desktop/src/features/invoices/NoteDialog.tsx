/**
 * A credit note (CN-) or debit note (DN-) against an issued invoice; the original never changes
 * (golden rule 3). Item lines: which original lines and how many (a credit note never more than
 * is left), optionally a correction price, and where returned goods go (sellable or defective,
 * decision 0015). A payment invoice is credited by an amount (work cancelled, decision 0013).
 * A credit note may refund the money now; otherwise it stays as the customer's credit.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fitsUnitDecimals,
  formatFils,
  formatQuantity,
  MoneyFormatError,
  parse4dp,
  parseFils,
  parseQuantity,
} from '@artepool/shared';
import type { CreateNoteRequest, DocumentDetail, SalesLine } from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { useSave } from '../../api/hooks';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogFooter,
  InfoBar,
  SelectField,
  tableClasses as tbl,
  TextField,
} from '../../ui';
import { useCan } from '../auth/context';
import { ruleOf, SaveError } from '../inventory/parts';
import { ApprovalDialog } from '../masterdata/ApprovalDialog';
import { money, price } from '../masterdata/format';
import { localName, useReasonCodes } from '../masterdata/refs';
import { SALES_INVALIDATE, SALES_PATHS, useSalesPaymentMethods } from '../sales/api';
import { useLineRefs } from '../sales/LineEditor';
import salesStyles from '../sales/sales.module.css';
import { PaymentPartsEditor, readParts, type PartDraft, type PartProblem } from './parts';
import styles from './invoices.module.css';

type Back = 'available' | 'defective' | 'none';

interface LineDraft {
  quantity: string;
  price: string;
  back: Back;
  /** The person picked where the goods go (otherwise a price correction means none). */
  backChosen?: boolean;
}

type LineProblem = 'quantity' | 'tooMany' | 'decimals' | 'price';

const tryParse = (fn: (s: string) => bigint, text: string): bigint | null => {
  try {
    return fn(text.trim());
  } catch (error) {
    if (error instanceof MoneyFormatError) return null;
    throw error;
  }
};

const qtyText = (milli: bigint) => formatQuantity(milli).replace(/\.?0+$/, '') || '0';

/** What the server refuses when the person may not issue credit notes without an approval. */
const needsNoteApproval = (error: unknown) =>
  ruleOf(error) === 'APPROVAL_REQUIRED' ||
  (error instanceof ApiError &&
    error.code === 'PERMISSION_DENIED' &&
    error.details.permission === 'credit_notes.issue');

export function NoteDialog(props: {
  kind: 'credit_note' | 'debit_note';
  original: DocumentDetail;
  onClose: () => void;
  onCreated: (note: DocumentDetail) => void;
}) {
  const { t, i18n } = useTranslation('invoices');
  const name = localName(i18n.language);
  const can = useCan();
  const refs = useLineRefs();
  const reasons = useReasonCodes();
  const methods = useSalesPaymentMethods();
  const { kind, original } = props;
  const credit = kind === 'credit_note';
  const advance = original.docType === 'advance_invoice';
  const advanceLeft =
    BigInt(original.advanceLeftNetFils ?? '0') + BigInt(original.advanceLeftVatFils ?? '0');
  const itemLines = original.lines.filter((l) => l.lineKind === 'item');
  const leftOf = (l: SalesLine) =>
    credit ? BigInt(l.quantityMilli) - BigInt(l.creditedMilli ?? '0') : BigInt(l.quantityMilli);

  const [reasonCodeId, setReasonCodeId] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [lines, setLines] = useState<Record<string, LineDraft>>({});
  const [amount, setAmount] = useState(advance ? formatFils(advanceLeft) : '');
  const [refunding, setRefunding] = useState(false);
  const [parts, setParts] = useState<PartDraft[]>([]);
  const [partProblems, setPartProblems] = useState<Record<number, PartProblem>>({});
  const [lineProblems, setLineProblems] = useState<Record<string, LineProblem>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [approving, setApproving] = useState<CreateNoteRequest | null>(null);

  const choices = (reasons.data ?? []).filter((r) => r.isActive && r.category === kind);
  const draftOf = (id: string): LineDraft =>
    lines[id] ?? { quantity: '', price: '', back: 'available' };
  const setLine = (id: string, patch: Partial<LineDraft>) =>
    setLines((all) => ({ ...all, [id]: { ...draftOf(id), ...patch } }));

  const create = useSave(
    (a, body: CreateNoteRequest, key) =>
      a.post<DocumentDetail>(SALES_PATHS.notes, body, { idempotencyKey: key }),
    { invalidate: SALES_INVALIDATE, onSuccess: (note) => props.onCreated(note) },
  );

  const send = (body: CreateNoteRequest) =>
    create.mutate(body, {
      onError: (error) => {
        if (credit && !body.approvalId && needsNoteApproval(error)) setApproving(body);
      },
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    create.reset();
    if (!reasonCodeId) return setProblem(t('notes.problems.reason'));
    if (reasonText.trim().length < 3) return setProblem(t('notes.problems.reasonText'));

    let body: CreateNoteRequest = {
      kind,
      originalDocumentId: original.id,
      reasonCodeId,
      reasonText: reasonText.trim(),
    };
    if (advance) {
      const fils = tryParse(parseFils, amount);
      if (fils === null || fils <= 0n || fils > advanceLeft)
        return setProblem(t('notes.problems.amount', { amount: money(advanceLeft) }));
      body = { ...body, advanceAmountFils: fils.toString() };
    } else {
      const found: Record<string, LineProblem> = {};
      const out: NonNullable<CreateNoteRequest['lines']> = [];
      for (const l of itemLines) {
        const d = draftOf(l.id);
        if (d.quantity.trim() === '') continue;
        const milli = tryParse(parseQuantity, d.quantity);
        if (milli === null || milli <= 0n) found[l.id] = 'quantity';
        else if (credit && milli > leftOf(l)) found[l.id] = 'tooMany';
        else if (!fitsUnitDecimals(milli, refs.unitDecimalsOf(l.unitId ?? '')))
          found[l.id] = 'decimals';
        const unitPrice = d.price.trim() === '' ? null : tryParse(parse4dp, d.price);
        if (d.price.trim() !== '' && (unitPrice === null || unitPrice < 0n)) found[l.id] = 'price';
        if (found[l.id] || milli === null) continue;
        out.push({
          originalLineId: l.id,
          quantityMilli: milli.toString(),
          ...(unitPrice !== null ? { unitPrice4dp: unitPrice.toString() } : {}),
          ...(credit ? { returnStockStatus: d.back === 'none' ? null : d.back } : {}),
        });
      }
      setLineProblems(found);
      if (Object.keys(found).length > 0) return;
      if (out.length === 0) return setProblem(t('notes.problems.lines'));
      body = { ...body, lines: out };
    }
    if (credit && refunding) {
      const read = readParts(parts, methods.data ?? []);
      if (!read.ok) return setPartProblems(read.problems);
      setPartProblems({});
      if (read.value.length > 0) body = { ...body, refund: read.value };
    }
    send(body);
  };

  const title = credit ? t('notes.creditTitle') : t('notes.debitTitle');
  return (
    <>
      <Dialog isOpen onClose={props.onClose} title={title} wide>
        <form onSubmit={submit} noValidate className={salesStyles.form}>
          <InfoBar>
            {credit ? t('notes.creditExplain') : t('notes.debitExplain')}{' '}
            <bdi>{original.docNumber}</bdi>
          </InfoBar>
          <SelectField
            id="note-reason"
            label={t('notes.reason')}
            value={reasonCodeId}
            onChange={setReasonCodeId}
            options={[
              { value: '', label: t('notes.chooseReason') },
              ...choices.map((r) => ({ value: r.id, label: name(r) })),
            ]}
          />
          <TextField
            label={t('notes.reasonText')}
            value={reasonText}
            onChange={setReasonText}
            isRequired
            multiline
          />

          {advance ? (
            <TextField
              label={t('notes.advanceAmount')}
              value={amount}
              onChange={setAmount}
              ltr
              inputMode="numeric"
              hint={t('notes.advanceLeft', { amount: money(advanceLeft) })}
            />
          ) : (
            <div className={salesStyles.tableWrap}>
              <table className={`${tbl.table} ${styles.noteLines}`} aria-label={t('notes.lines')}>
                <thead>
                  <tr>
                    <th>{t('sales:lines.item')}</th>
                    <th className={tbl.num}>{t('notes.left')}</th>
                    <th>{t('sales:lines.quantity')}</th>
                    <th>{t('notes.price')}</th>
                    {credit && <th>{t('notes.goesTo')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {itemLines.map((l) => {
                    const d = draftOf(l.id);
                    const left = leftOf(l);
                    const label = i18n.language === 'en' ? l.descriptionEn : l.descriptionAr;
                    const lp = lineProblems[l.id];
                    return (
                      <tr key={l.id}>
                        <td>
                          <span>{label}</span>
                          <span className={tbl.sub}>
                            {l.itemCode && <bdi>{l.itemCode}</bdi>} ·{' '}
                            <bdi>{price(BigInt(l.unitPrice4dp))}</bdi>
                          </span>
                        </td>
                        <td className={tbl.num}>
                          <bdi>{qtyText(left)}</bdi>
                        </td>
                        <td>
                          <input
                            className={salesStyles.cellInput}
                            inputMode="decimal"
                            aria-label={t('notes.quantityOf', { name: label })}
                            value={d.quantity}
                            disabled={credit && left <= 0n}
                            onChange={(e) => setLine(l.id, { quantity: e.target.value })}
                          />
                          {lp && lp !== 'price' && (
                            <span className={salesStyles.fieldError}>
                              {t(`notes.problems.${lp}`, { left: qtyText(left) })}
                            </span>
                          )}
                        </td>
                        <td>
                          <input
                            className={salesStyles.cellInput}
                            inputMode="decimal"
                            aria-label={t('notes.priceOf', { name: label })}
                            placeholder={price(BigInt(l.unitPrice4dp))}
                            value={d.price}
                            onChange={(e) =>
                              // A price correction returns no goods unless the person says so.
                              setLine(l.id, {
                                price: e.target.value,
                                ...(!d.backChosen && e.target.value.trim() !== ''
                                  ? { back: 'none' as const }
                                  : {}),
                              })
                            }
                          />
                          {lp === 'price' && (
                            <span className={salesStyles.fieldError}>
                              {t('notes.problems.price')}
                            </span>
                          )}
                        </td>
                        {credit && (
                          <td>
                            <select
                              aria-label={t('notes.goesToOf', { name: label })}
                              value={d.back}
                              onChange={(e) =>
                                setLine(l.id, { back: e.target.value as Back, backChosen: true })
                              }
                            >
                              <option value="available">{t('notes.back.available')}</option>
                              <option value="defective">{t('notes.back.defective')}</option>
                              <option value="none">{t('notes.back.none')}</option>
                            </select>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className={salesStyles.muted}>
                {credit ? t('notes.creditLinesHint') : t('notes.debitLinesHint')}
              </p>
            </div>
          )}

          {credit && can('payments.refund') && (
            <>
              <Checkbox isSelected={refunding} onChange={setRefunding}>
                {t('notes.refundNow')}
              </Checkbox>
              {refunding ? (
                <PaymentPartsEditor
                  parts={parts}
                  onChange={setParts}
                  methods={methods.data ?? []}
                  problems={partProblems}
                />
              ) : (
                <p className={salesStyles.muted}>{t('notes.keptAsCredit')}</p>
              )}
            </>
          )}

          {problem && <Alert>{problem}</Alert>}
          {create.error !== null && !(approving || needsNoteApproval(create.error)) && (
            <SaveError error={create.error} />
          )}
          {create.error !== null && needsNoteApproval(create.error) && !approving && (
            <Alert tone="warn">{t('sales:approval.noteExplain')}</Alert>
          )}
          <DialogFooter>
            <Button onPress={props.onClose}>{t('form.keep')}</Button>
            <Button type="submit" variant="primary" busy={create.isPending}>
              {credit ? t('notes.issueCredit') : t('notes.issueDebit')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      {approving && (
        <ApprovalDialog
          permission="credit_notes.issue"
          title={t('sales:approval.noteTitle')}
          explanation={t('sales:approval.noteExplain')}
          subject={
            <>
              <b>{original.billToName}</b> · <bdi>{original.docNumber}</bdi>
            </>
          }
          context={{ action: 'credit_note', originalDocumentId: original.id }}
          onClose={() => setApproving(null)}
          onApproved={(approvalId) => {
            const body = { ...approving, approvalId };
            setApproving(null);
            send(body);
          }}
        />
      )}
    </>
  );
}
