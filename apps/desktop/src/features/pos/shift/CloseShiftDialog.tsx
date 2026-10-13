/**
 * Closing the shift (decisions 0006, 0056): the cashier counts the drawer by note and coin, plus
 * an "other amount", WITHOUT seeing what the system expects (blind count). Only after the count is
 * saved the expected amount and the over/short appear. One recount is allowed, with a supervisor's
 * approval; both counts are kept. Then the shift closes and the Z report is frozen.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoneyFormatError, parseFils } from '@artepool/shared';
import type { CountResult, PosState, ShiftReport } from '@artepool/shared/contracts';
import { useSave } from '../../../api/hooks';
import { Alert, Button, cx, Dialog, DialogFooter, Note, TextField } from '../../../ui';
import { useErrorText } from '../../auth/context';
import { ApprovalDialog } from '../../masterdata/ApprovalDialog';
import { money } from '../../masterdata/format';
import { POS_INVALIDATE, POS_PATHS } from '../api';
import styles from '../pos.module.css';

type Counts = Record<string, string>;

const readCount = (text: string): number | null =>
  text.trim() === '' ? 0 : /^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : null;

export function CloseShiftDialog(props: {
  state: PosState;
  onClose: () => void;
  onClosed: (report: ShiftReport) => void;
}) {
  const { t } = useTranslation('pos');
  const errorText = useErrorText();
  const [counts, setCounts] = useState<Counts>({});
  const [other, setOther] = useState('');
  const [result, setResult] = useState<CountResult | null>(null);
  const [recounting, setRecounting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const denominations = props.state.denominations;
  const otherFils = (() => {
    try {
      return other.trim() === '' ? 0n : parseFils(other.trim());
    } catch (e) {
      if (e instanceof MoneyFormatError) return null;
      throw e;
    }
  })();
  const total = denominations.reduce((sum, d) => {
    const n = readCount(counts[d.id] ?? '');
    return n === null ? sum : sum + BigInt(d.valueFils) * BigInt(n);
  }, otherFils ?? 0n);
  const invalid =
    otherFils === null ||
    otherFils < 0n ||
    denominations.some((d) => readCount(counts[d.id] ?? '') === null);

  const count = useSave(
    (api, body: { recount: boolean; approvalId?: string }, key) =>
      api.post<CountResult>(
        body.recount ? POS_PATHS.recount : POS_PATHS.count,
        {
          lines: denominations
            .map((d) => ({ denominationId: d.id, quantity: readCount(counts[d.id] ?? '') ?? 0 }))
            .filter((l) => l.quantity > 0),
          otherAmountFils: (otherFils ?? 0n).toString(),
          ...(body.approvalId ? { approvalId: body.approvalId } : {}),
        },
        { idempotencyKey: key },
      ),
    {
      onSuccess: (r) => {
        setResult(r);
        setRecounting(false);
      },
    },
  );
  const close = useSave(
    (api, varianceNote: string, key) =>
      api.post<ShiftReport>(POS_PATHS.close, varianceNote ? { varianceNote } : {}, {
        idempotencyKey: key,
      }),
    { invalidate: POS_INVALIDATE, onSuccess: (report) => props.onClosed(report) },
  );

  const counting = result === null || recounting;
  const saveCount = (approvalId?: string) => {
    setProblem(null);
    if (invalid) return setProblem(t('closeShift.invalid'));
    count.mutate(
      { recount: recounting, ...(approvalId ? { approvalId } : {}) },
      { onError: (e) => setProblem(errorText(e)) },
    );
  };

  return (
    <>
      <Dialog
        isOpen
        onClose={props.onClose}
        title={recounting ? t('closeShift.recountTitle') : t('closeShift.title')}
      >
        {counting ? (
          <div className={styles.payForm}>
            <Note>{t('closeShift.blindHelp')}</Note>
            <table className={styles.countTable}>
              <thead>
                <tr>
                  <th>{t('closeShift.denomination')}</th>
                  <th>{t('closeShift.quantity')}</th>
                  <th>{t('closeShift.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {denominations.map((d) => {
                  const n = readCount(counts[d.id] ?? '');
                  return (
                    <tr key={d.id}>
                      <td>
                        <bdi>{money(BigInt(d.valueFils))}</bdi>{' '}
                        <span className={styles.muted}>{t(`closeShift.${d.kind}`)}</span>
                      </td>
                      <td>
                        <input
                          className={cx(styles.qtyInput, n === null && styles.bad)}
                          inputMode="numeric"
                          aria-label={t('closeShift.countOf', {
                            value: money(BigInt(d.valueFils)),
                          })}
                          value={counts[d.id] ?? ''}
                          onChange={(e) => setCounts({ ...counts, [d.id]: e.target.value })}
                        />
                      </td>
                      <td>
                        <bdi>{n === null ? '—' : money(BigInt(d.valueFils) * BigInt(n))}</bdi>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <TextField
              label={t('closeShift.other')}
              value={other}
              onChange={setOther}
              inputMode="decimal"
              ltr
              hint={t('closeShift.otherHint')}
            />
            <div className={styles.change}>
              <span>{t('closeShift.counted')}</span>
              <b data-testid="count-total">
                <bdi>{money(total)}</bdi>
              </b>
            </div>
            {problem && <Alert>{problem}</Alert>}
            <DialogFooter>
              <Button onPress={props.onClose}>{t('cancel')}</Button>
              <Button
                variant="primary"
                busy={count.isPending}
                onPress={() => (recounting ? setApproving(true) : saveCount())}
              >
                {t('closeShift.saveCount')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className={styles.payForm}>
            <dl className={styles.totals}>
              <dt>{t('closeShift.counted')}</dt>
              <dd>
                <bdi>{money(BigInt(result.countedFils))}</bdi>
              </dd>
              <dt>{t('closeShift.expected')}</dt>
              <dd>
                <bdi>{money(BigInt(result.expectedFils))}</bdi>
              </dd>
              <dt className={styles.grand}>{t('closeShift.variance')}</dt>
              <dd
                className={cx(
                  styles.grand,
                  BigInt(result.varianceFils) !== 0n && styles.varianceOff,
                )}
                data-testid="variance"
              >
                <bdi>{money(BigInt(result.varianceFils))}</bdi>
              </dd>
            </dl>
            {BigInt(result.varianceFils) === 0n ? (
              <Note>{t('closeShift.matches')}</Note>
            ) : (
              <Alert tone="warn">
                {BigInt(result.varianceFils) < 0n ? t('closeShift.short') : t('closeShift.over')}
              </Alert>
            )}
            {BigInt(result.varianceFils) !== 0n && (
              <TextField label={t('closeShift.varianceNote')} value={note} onChange={setNote} />
            )}
            {problem && <Alert>{problem}</Alert>}
            {close.error !== null && <Alert>{errorText(close.error)}</Alert>}
            <DialogFooter>
              {result.canRecount && BigInt(result.varianceFils) !== 0n && (
                <Button
                  onPress={() => {
                    setCounts({});
                    setOther('');
                    setRecounting(true);
                  }}
                >
                  {t('closeShift.recount')}
                </Button>
              )}
              <Button
                variant="primary"
                busy={close.isPending}
                onPress={() => close.mutate(note.trim())}
              >
                {t('closeShift.close')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </Dialog>
      {approving && (
        <ApprovalDialog
          permission="shifts.recount"
          title={t('approval.shifts.recount.title')}
          explanation={t('approval.shifts.recount.explain')}
          onClose={() => setApproving(false)}
          onApproved={(id) => {
            setApproving(false);
            saveCount(id);
          }}
        />
      )}
    </>
  );
}
