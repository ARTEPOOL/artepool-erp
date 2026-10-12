/**
 * Small pieces of the Quotations section: the status chip (text + icon + colour), the validity
 * marker of a sent quotation, the per-line errors the server returns, and a saved quotation
 * turned back into a save request (for a new revision).
 */
import type { ReactNode } from 'react';
import {
  Ban,
  CalendarX,
  CheckCircle2,
  Clock,
  FileCheck2,
  FilePen,
  History,
  Send,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  QuotationDetail,
  QuotationItem,
  QuotationStatus,
  SaveQuotationRequest,
} from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { addDays } from '../../lib/format';
import { Chip, type Tone } from '../../ui';
import { lineFromSaved, toRequest, type EditorLine } from '../sales/lines';

const STATUS_LOOK: Record<QuotationStatus, { tone: Tone; icon: ReactNode }> = {
  draft: { tone: 'neutral', icon: <FilePen aria-hidden="true" /> },
  sent: { tone: 'info', icon: <Send aria-hidden="true" /> },
  accepted: { tone: 'ok', icon: <CheckCircle2 aria-hidden="true" /> },
  rejected: { tone: 'danger', icon: <XCircle aria-hidden="true" /> },
  expired: { tone: 'warn', icon: <CalendarX aria-hidden="true" /> },
  converted: { tone: 'primary', icon: <FileCheck2 aria-hidden="true" /> },
  cancelled: { tone: 'neutral', icon: <Ban aria-hidden="true" /> },
  superseded: { tone: 'neutral', icon: <History aria-hidden="true" /> },
};

/** Status = text + icon + colour, never colour alone. */
export function QuotationStatusChip({ status }: { status: QuotationStatus }) {
  const { t } = useTranslation('sales');
  const look = STATUS_LOOK[status];
  return (
    <Chip tone={look.tone} icon={look.icon}>
      {t(`quotationStatuses.${status}`)}
    </Chip>
  );
}

/** Days before the end of validity when a sent quotation is marked "expires soon". */
export const SOON_DAYS = 3;

export type Validity = 'expired' | 'soon' | null;

/** Only a sent quotation waits for the customer, so only it can run out of time. */
export function validityOf(
  q: Pick<QuotationItem, 'status' | 'validUntil'>,
  today: string,
): Validity {
  if (q.status !== 'sent') return null;
  if (q.validUntil < today) return 'expired';
  if (q.validUntil <= addDays(today, SOON_DAYS)) return 'soon';
  return null;
}

export function ValidityChip({ validity }: { validity: Validity }) {
  const { t } = useTranslation('quotations');
  if (validity === null) return null;
  return validity === 'expired' ? (
    <Chip tone="danger" icon={<CalendarX aria-hidden="true" />}>
      {t('validity.expired')}
    </Chip>
  ) : (
    <Chip tone="warn" icon={<Clock aria-hidden="true" />}>
      {t('validity.soon')}
    </Chip>
  );
}

/** "Q-000012" or "Q-000012/2" for a later revision. */
export const quotationNumber = (q: Pick<QuotationItem, 'docNumber' | 'revision'>): string =>
  q.revision > 1 ? `${q.docNumber}/${q.revision}` : q.docNumber;

/**
 * The server's refusal of a line (`lines.<index>.<field>`) → line index → field error code.
 * Zod paths come as ['lines', 0, 'quantityMilli'], the server's own as ['lines.0.itemId'].
 */
export function lineIssues(error: unknown): Record<number, string> {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_FAILED') return {};
  const issues = error.details.issues;
  if (!Array.isArray(issues)) return {};
  const found: Record<number, string> = {};
  for (const issue of issues as { path?: unknown[]; code?: unknown }[]) {
    const path = (issue.path ?? []).map(String).join('.');
    const match = /^lines\.(\d+)(?:\.|$)/.exec(path);
    if (!match) continue;
    const index = Number(match[1]);
    if (found[index] === undefined)
      found[index] = typeof issue.code === 'string' ? issue.code : 'invalid';
  }
  return found;
}

/** A saved quotation's lines back into the editor, named from the saved descriptions. */
export const editorLinesOf = (q: QuotationDetail): EditorLine[] =>
  q.lines
    .filter((l) => l.lineKind === 'item')
    .map((l) => lineFromSaved(l, { nameAr: l.descriptionAr, nameEn: l.descriptionEn }));

/**
 * A new revision starts with the same customer, texts and lines (agreed prices and discounts
 * kept); its date and validity start again from today unless changed in the new draft.
 */
export function revisionRequest(
  q: QuotationDetail,
  unitDecimalsOf: (unitId: string) => number,
): SaveQuotationRequest | null {
  const saved = q.lines.filter((l) => l.lineKind === 'item');
  const read = toRequest(editorLinesOf(q), unitDecimalsOf);
  if (read === null || read.length === 0) return null;
  // The agreed prices stay, even if an item's price changed since the quotation was sent.
  const lines = read.map((l, i) => ({ ...l, unitPrice4dp: saved[i]!.unitPrice4dp }));
  return {
    customerId: q.customerId,
    businessLineId: q.businessLineId,
    ...(q.subject ? { subject: q.subject } : {}),
    ...(q.termsAr ? { termsAr: q.termsAr } : {}),
    ...(q.termsEn ? { termsEn: q.termsEn } : {}),
    ...(q.notes ? { notes: q.notes } : {}),
    ...(BigInt(q.docDiscountFils) > 0n ? { docDiscountFils: q.docDiscountFils } : {}),
    lines,
  };
}
