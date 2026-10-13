/**
 * Issuing a saved draft: the number, stock, journal entry and any payment received now are one
 * transaction on the server. "Paid now" may be split across several methods. Leaving part unpaid
 * is allowed for a customer with credit; a cash customer, or one over their limit, needs a
 * supervisor's approval (decision 0046). A discount above the limit or a changed price needs one
 * too; the same issue is then sent again with the approval.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { DocumentDetail, IssueRequest, PaymentPart } from '@artepool/shared/contracts';
import { formatFils } from '@artepool/shared';
import { useSave } from '../../api/hooks';
import { Alert, Button, Dialog, DialogFooter, InfoBar } from '../../ui';
import { useCan } from '../auth/context';
import { ruleOf, SaveError } from '../inventory/parts';
import { ApprovalDialog } from '../masterdata/ApprovalDialog';
import { money } from '../masterdata/format';
import { SALES_INVALIDATE, SALES_KEYS, SALES_PATHS, useSalesPaymentMethods } from '../sales/api';
import salesStyles from '../sales/sales.module.css';
import { PaymentPartsEditor, readParts, type PartDraft, type PartProblem } from './parts';
import styles from './invoices.module.css';

type Asking = 'discount' | 'price' | 'credit';

const APPROVAL: Record<Asking, { permission: string; title: string; explain: string }> = {
  discount: {
    permission: 'sales.discount_over_limit',
    title: 'sales:approval.discountTitle',
    explain: 'sales:approval.discountExplain',
  },
  price: {
    permission: 'sales.price_override',
    title: 'sales:approval.priceTitle',
    explain: 'sales:approval.priceExplain',
  },
  credit: {
    permission: 'sales.credit_over_limit',
    title: 'sales:approval.creditTitle',
    explain: 'sales:approval.creditExplain',
  },
};

const ASKING_FOR_RULE: Record<string, Asking> = {
  DISCOUNT_OVER_LIMIT: 'discount',
  PRICE_OVERRIDE: 'price',
  CREDIT_LIMIT: 'credit',
};

/** Each approval is for one thing: a discount, changed prices, or the credit (decision 0046). */
interface Approvals {
  approvalId?: string;
  priceApprovalId?: string;
  creditApprovalId?: string;
}

const GIVEN: Record<Asking, keyof Approvals> = {
  discount: 'approvalId',
  price: 'priceApprovalId',
  credit: 'creditApprovalId',
};

export function IssueDialog(props: {
  doc: DocumentDetail;
  onClose: () => void;
  onIssued: (doc: DocumentDetail) => void;
}) {
  const { t } = useTranslation('invoices');
  const can = useCan();
  const queryClient = useQueryClient();
  const methods = useSalesPaymentMethods();
  const doc = props.doc;
  const dueFils = BigInt(doc.totalFils) - BigInt(doc.settledFils);
  const canPay = can('payments.receive');
  const [parts, setParts] = useState<PartDraft[]>([]);
  const [problems, setProblems] = useState<Record<number, PartProblem>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<Approvals>({});
  const [asking, setAsking] = useState<Asking | null>(null);
  const [payments, setPayments] = useState<PaymentPart[]>([]);

  const issue = useSave(
    (a, body: IssueRequest, key) =>
      a.post<DocumentDetail>(SALES_PATHS.issue(doc.id), body, { idempotencyKey: key }),
    {
      invalidate: SALES_INVALIDATE,
      onSuccess: (issued) => {
        queryClient.setQueryData(SALES_KEYS.document(issued.id), issued);
        props.onIssued(issued);
      },
    },
  );

  const send = (paid: PaymentPart[], given: Approvals) => {
    issue.mutate(
      {
        rowVersion: doc.rowVersion,
        ...(paid.length > 0 ? { payments: paid } : {}),
        ...(given.approvalId ? { approvalId: given.approvalId } : {}),
        ...(given.priceApprovalId ? { priceApprovalId: given.priceApprovalId } : {}),
        ...(given.creditApprovalId ? { creditApprovalId: given.creditApprovalId } : {}),
      },
      {
        onError: (error) => {
          const wanted = ASKING_FOR_RULE[ruleOf(error) ?? ''];
          // Ask only for an approval not already given for this issue.
          if (wanted && !given[GIVEN[wanted]]) setAsking(wanted);
        },
      },
    );
  };

  const typed = readParts(parts, methods.data ?? []);
  const typedFils = typed.ok ? typed.totalFils : 0n;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    issue.reset();
    const read = readParts(parts, methods.data ?? []);
    if (!read.ok) {
      setProblems(read.problems);
      return;
    }
    setProblems({});
    if (read.totalFils > dueFils) return setProblem(t('issue.moreThanDue'));
    setPayments(read.value);
    send(read.value, approvals);
  };

  const left = dueFils - typedFils;
  const approval = asking ? APPROVAL[asking] : null;
  const refusedForApproval =
    issue.error !== null && ASKING_FOR_RULE[ruleOf(issue.error) ?? ''] !== undefined;

  return (
    <>
      <Dialog isOpen onClose={props.onClose} title={t('issue.title')} wide>
        <form onSubmit={submit} noValidate className={salesStyles.form}>
          <InfoBar>{t('issue.explain')}</InfoBar>
          <div className={styles.summary}>
            <span>{t('sales:totals.due')}</span>
            <b className={styles.bigDue} data-testid="issue-due">
              <bdi>{money(dueFils)}</bdi>
            </b>
          </div>
          {canPay ? (
            <>
              <h3>{t('issue.paidNow')}</h3>
              {parts.length === 0 && <p className={salesStyles.muted}>{t('issue.unpaidHint')}</p>}
              <PaymentPartsEditor
                parts={parts}
                onChange={setParts}
                methods={methods.data ?? []}
                problems={problems}
                suggestAmount={left > 0n ? formatFils(left) : ''}
              />
              <div className={styles.summary}>
                <span>{t('issue.paying')}</span>
                <b>
                  <bdi>{money(typedFils)}</bdi>
                </b>
              </div>
              <div className={styles.summary}>
                <span>{t('issue.leftUnpaid')}</span>
                <b>
                  <bdi>{money(left)}</bdi>
                </b>
              </div>
            </>
          ) : (
            <p className={salesStyles.muted}>{t('issue.noPayments')}</p>
          )}
          {problem && <Alert>{problem}</Alert>}
          {issue.error !== null && (!refusedForApproval || asking === null) && (
            <SaveError
              error={issue.error}
              onReload={() => {
                props.onClose();
                void queryClient.invalidateQueries({ queryKey: SALES_KEYS.document(doc.id) });
              }}
            />
          )}
          <DialogFooter>
            <Button onPress={props.onClose}>{t('form.keep')}</Button>
            <Button type="submit" variant="primary" busy={issue.isPending}>
              {t('issue.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      {asking && approval && (
        <ApprovalDialog
          permission={approval.permission}
          title={t(approval.title)}
          explanation={t(approval.explain)}
          subject={
            <>
              <b>{doc.billToName}</b> · <bdi>{money(dueFils)}</bdi>
            </>
          }
          context={{
            action: 'issue_invoice',
            documentId: doc.id,
            entity:
              asking === 'discount'
                ? `sales.documents:${doc.id}`
                : `sales.documents:${doc.id}:${asking}`,
          }}
          onClose={() => setAsking(null)}
          onApproved={(approvalId) => {
            const next: Approvals = { ...approvals, [GIVEN[asking]]: approvalId };
            setAsking(null);
            setApprovals(next);
            send(payments, next);
          }}
        />
      )}
    </>
  );
}
