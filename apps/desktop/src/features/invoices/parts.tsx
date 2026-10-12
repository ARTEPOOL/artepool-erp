/**
 * Small pieces of the Invoices (A4) section: status chips (text + icon + colour), the "paid now"
 * payment parts used at issue and for a refund, and reading the server's per-line errors.
 */
import { useEffect, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  FilePen,
  FileText,
  Plus,
  ReceiptText,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MoneyFormatError, parseFils } from '@artepool/shared';
import type {
  DocStatus,
  InvoiceFormat,
  PaymentPart,
  SalesPaymentMethod,
  SettlementStatus,
} from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { Button, Chip, IconButton, iconClass, SelectField, TextField } from '../../ui';
import { localName } from '../masterdata/refs';
import styles from './invoices.module.css';

export function useDebounced(value: string, ms = 250): string {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setShown(value.trim()), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

export function StatusChip({ status }: { status: DocStatus }) {
  const { t } = useTranslation('sales');
  if (status === 'issued')
    return (
      <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
        {t('statuses.issued')}
      </Chip>
    );
  if (status === 'discarded')
    return <Chip icon={<Ban aria-hidden="true" />}>{t('statuses.discarded')}</Chip>;
  return (
    <Chip tone="info" icon={<FilePen aria-hidden="true" />}>
      {t('statuses.draft')}
    </Chip>
  );
}

export function SettlementChip({ status }: { status: SettlementStatus }) {
  const { t } = useTranslation('sales');
  if (status === 'settled')
    return (
      <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
        {t('settlement.settled')}
      </Chip>
    );
  if (status === 'partial')
    return (
      <Chip tone="info" icon={<CircleDashed aria-hidden="true" />}>
        {t('settlement.partial')}
      </Chip>
    );
  return (
    <Chip tone="warn" icon={<Clock aria-hidden="true" />}>
      {t('settlement.open')}
    </Chip>
  );
}

export function FormatChip({ format }: { format: InvoiceFormat }) {
  const { t } = useTranslation('sales');
  return format === 'full' ? (
    <Chip tone="primary" icon={<FileText aria-hidden="true" />}>
      {t('formats.full')}
    </Chip>
  ) : (
    <Chip icon={<ReceiptText aria-hidden="true" />}>{t('formats.simplified')}</Chip>
  );
}

/** A date (yyyy-mm-dd) typed or picked; dates read left to right in both languages. */
export function DateField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <div className={styles.dateField}>
      <label>
        <span>{props.label}</span>
        <input
          type="date"
          dir="ltr"
          value={props.value}
          aria-invalid={props.error ? true : undefined}
          onChange={(event) => props.onChange(event.target.value)}
        />
      </label>
      {props.error && <span className={styles.negative}>{props.error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Payment parts
// ---------------------------------------------------------------------------------------------

export interface PartDraft {
  key: number;
  methodId: string;
  amount: string;
  reference: string;
  chequeDate: string;
  chequeBank: string;
}

let nextPart = 0;
export const newPart = (methodId = '', amount = ''): PartDraft => ({
  key: (nextPart += 1),
  methodId,
  amount,
  reference: '',
  chequeDate: '',
  chequeBank: '',
});

export type PartProblem = 'method' | 'amount' | 'reference' | 'chequeDate';

const readAmount = (text: string): bigint | null => {
  try {
    const v = parseFils(text.trim());
    return v > 0n ? v : null;
  } catch (error) {
    if (error instanceof MoneyFormatError) return null;
    throw error;
  }
};

/** The typed parts as the server expects them, or the first problem of each part. */
export function readParts(
  parts: PartDraft[],
  methods: SalesPaymentMethod[],
):
  | { ok: true; value: PaymentPart[]; totalFils: bigint }
  | { ok: false; problems: Record<number, PartProblem> } {
  const problems: Record<number, PartProblem> = {};
  const value: PaymentPart[] = [];
  let totalFils = 0n;
  for (const p of parts) {
    const method = methods.find((m) => m.id === p.methodId);
    const amount = readAmount(p.amount);
    if (!method) problems[p.key] = 'method';
    else if (amount === null) problems[p.key] = 'amount';
    else if (method.requiresReference && p.reference.trim() === '') problems[p.key] = 'reference';
    else if (method.kind === 'cheque' && p.chequeDate.trim() === '') problems[p.key] = 'chequeDate';
    if (problems[p.key] || !method || amount === null) continue;
    totalFils += amount;
    value.push({
      paymentMethodId: method.id,
      amountFils: amount.toString(),
      ...(p.reference.trim() ? { reference: p.reference.trim() } : {}),
      ...(method.kind === 'cheque' ? { chequeDate: p.chequeDate.trim() } : {}),
      ...(method.kind === 'cheque' && p.chequeBank.trim()
        ? { chequeBank: p.chequeBank.trim() }
        : {}),
    });
  }
  return Object.keys(problems).length > 0
    ? { ok: false, problems }
    : { ok: true, value, totalFils };
}

/** "Paid now": one or more ways of paying (a split payment), each with its own amount. */
export function PaymentPartsEditor(props: {
  parts: PartDraft[];
  onChange: (parts: PartDraft[]) => void;
  methods: SalesPaymentMethod[];
  problems: Record<number, PartProblem>;
  /** Pre-fills the amount of a new part. */
  suggestAmount?: string;
}) {
  const { t, i18n } = useTranslation('invoices');
  const name = localName(i18n.language);
  const update = (key: number, patch: Partial<PartDraft>) =>
    props.onChange(props.parts.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  return (
    <div className={styles.parts}>
      {props.parts.map((p, index) => {
        const method = props.methods.find((m) => m.id === p.methodId);
        const problem = props.problems[p.key];
        const n = String(index + 1);
        return (
          <div key={p.key} className={styles.part} role="group" aria-label={t('pay.part', { n })}>
            <SelectField
              id={`pay-method-${p.key}`}
              label={t('sales:fields.method')}
              value={p.methodId}
              onChange={(methodId) => update(p.key, { methodId })}
              options={[
                { value: '', label: t('pay.chooseMethod') },
                ...props.methods.map((m) => ({ value: m.id, label: name(m) })),
              ]}
            />
            <TextField
              label={t('sales:fields.amount')}
              value={p.amount}
              onChange={(amount) => update(p.key, { amount })}
              ltr
              inputMode="numeric"
              error={problem === 'amount' ? t('pay.problems.amount') : undefined}
            />
            <TextField
              label={t('sales:fields.reference')}
              value={p.reference}
              onChange={(reference) => update(p.key, { reference })}
              ltr
              error={problem === 'reference' ? t('pay.problems.reference') : undefined}
            />
            {method?.kind === 'cheque' && (
              <>
                <DateField
                  label={t('pay.chequeDate')}
                  value={p.chequeDate}
                  onChange={(chequeDate) => update(p.key, { chequeDate })}
                  error={problem === 'chequeDate' ? t('pay.problems.chequeDate') : undefined}
                />
                <TextField
                  label={t('pay.chequeBank')}
                  value={p.chequeBank}
                  onChange={(chequeBank) => update(p.key, { chequeBank })}
                />
              </>
            )}
            {problem === 'method' && (
              <span className={styles.negative}>{t('pay.problems.method')}</span>
            )}
            <IconButton
              aria-label={t('pay.remove', { n })}
              onPress={() => props.onChange(props.parts.filter((x) => x.key !== p.key))}
            >
              <Trash2 className={iconClass.sm} aria-hidden="true" />
            </IconButton>
          </div>
        );
      })}
      <div>
        <Button
          variant="ghost"
          onPress={() =>
            props.onChange([
              ...props.parts,
              newPart(props.methods[0]?.id ?? '', props.suggestAmount ?? ''),
            ])
          }
        >
          <Plus className={iconClass.sm} aria-hidden="true" />
          {t('pay.add')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Server errors
// ---------------------------------------------------------------------------------------------

/** The paths the server named in a refused save ("lines.2.quantityMilli", …). */
function issuePaths(error: unknown): { path: string; code: string }[] {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_FAILED') return [];
  const issues = error.details.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue) => {
    const i = issue as { path?: unknown; code?: unknown };
    if (!Array.isArray(i.path)) return [];
    return [{ path: i.path.map(String).join('.'), code: typeof i.code === 'string' ? i.code : '' }];
  });
}

/** Per-line errors (line index → code) of a refused save. */
export function lineErrorCodes(error: unknown): Record<number, string> {
  const out: Record<number, string> = {};
  for (const { path, code } of issuePaths(error)) {
    const match = /^lines\.(\d+)\./.exec(path);
    if (match) out[Number(match[1])] = code;
  }
  return out;
}

/** True when a refused save names a field other than a line (e.g. the document discount). */
export function fieldErrorCode(error: unknown, field: string): string | null {
  return issuePaths(error).find((i) => i.path === field)?.code ?? null;
}
