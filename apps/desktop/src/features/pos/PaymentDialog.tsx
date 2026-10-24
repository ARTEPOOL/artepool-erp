/**
 * Payment (design 04; decisions 0059, 0061): cash with the change worked out, card with the
 * approval code from the terminal slip only (never any card digits), or both. The sale is one
 * request; if the server asks for a supervisor (discount above the limit, a changed price, selling
 * beyond stock, an unpaid amount), the supervisor approves here and the same sale is sent again.
 * After the sale the receipt prints by itself and the drawer opens when cash was paid.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, FileText, Printer } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { MoneyFormatError, parseFils } from '@artepool/shared';
import type {
  PosPaymentPart,
  PosSaleResponse,
  PosState,
  ReceiptData,
  StockShortage,
} from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { useApi, useSave } from '../../api/hooks';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  iconClass,
  Note,
  Segmented,
  TextField,
} from '../../ui';
import { useErrorText } from '../auth/context';
import { ApprovalDialog } from '../masterdata/ApprovalDialog';
import { money } from '../masterdata/format';
import { localName } from '../masterdata/refs';
import { useLineRefs } from '../sales/LineEditor';
import { toRequest } from '../sales/lines';
import { APPROVAL_FIELD, APPROVAL_FOR_RULE, POS_INVALIDATE, POS_PATHS } from './api';
import { cartStore, useCart } from './cart';
import { printReceipt, type PrintOutcome } from './receipt/printer';
import styles from './pos.module.css';

type Mode = 'cash' | 'card' | 'split';

const readFils = (text: string): bigint | null => {
  try {
    return text.trim() === '' ? null : parseFils(text.trim());
  } catch (e) {
    if (e instanceof MoneyFormatError) return null;
    throw e;
  }
};

/** Quick buttons: the exact amount and the next round notes above it. */
export function quickTenders(totalFils: bigint): bigint[] {
  const out = [totalFils];
  for (const note of [500n, 1000n, 5000n, 10000n, 20000n, 50000n, 100000n]) {
    const up = ((totalFils + note - 1n) / note) * note;
    if (up > totalFils && !out.includes(up)) out.push(up);
    if (out.length >= 4) break;
  }
  return out;
}

export function PaymentDialog(props: {
  state: PosState;
  totalFils: bigint;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation('pos');
  const api = useApi();
  const navigate = useNavigate();
  const errorText = useErrorText();
  const cart = useCart();
  const refs = useLineRefs();
  const cash = props.state.paymentMethods.find((m) => m.kind === 'cash');
  const card = props.state.paymentMethods.find((m) => m.kind === 'card');
  const [mode, setMode] = useState<Mode>('cash');
  const [tendered, setTendered] = useState('');
  const [cashPart, setCashPart] = useState('');
  const [approvalCode, setApprovalCode] = useState('');
  const [approvals, setApprovals] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<{ permission: string; shortages?: StockShortage[] } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{
    sale: PosSaleResponse;
    print: PrintOutcome;
    image: string;
  } | null>(null);
  const total = props.totalFils;

  const sale = useSave(
    (client, body: Record<string, unknown>, key) =>
      client.post<PosSaleResponse>(POS_PATHS.sales, body, { idempotencyKey: key }),
    { invalidate: POS_INVALIDATE },
  );

  // What is paid, by method.
  const tenderedFils = readFils(tendered);
  const splitCash = readFils(cashPart) ?? 0n;
  const cardFils = mode === 'card' ? total : mode === 'split' ? total - splitCash : 0n;
  const cashFils = mode === 'cash' ? total : mode === 'split' ? splitCash : 0n;
  const change =
    mode === 'cash' && tenderedFils !== null && tenderedFils > total ? tenderedFils - total : 0n;
  const codeOk = /^[A-Za-z0-9]{2,12}$/.test(approvalCode.trim());
  const ready =
    (mode === 'cash' && (tenderedFils === null || tenderedFils >= total)) ||
    (mode === 'card' && codeOk) ||
    (mode === 'split' && splitCash > 0n && splitCash < total && codeOk);

  const payments = (): PosPaymentPart[] => {
    const parts: PosPaymentPart[] = [];
    if (cashFils > 0n && cash) {
      parts.push({
        paymentMethodId: cash.id,
        amountFils: cashFils.toString(),
        ...(mode === 'cash' && tenderedFils !== null && tenderedFils > total
          ? { tenderedFils: tenderedFils.toString() }
          : {}),
      });
    }
    if (cardFils > 0n && card) {
      parts.push({
        paymentMethodId: card.id,
        amountFils: cardFils.toString(),
        approvalCode: approvalCode.trim(),
      });
    }
    return parts;
  };

  const send = (withApprovals: Record<string, string>) => {
    setProblem(null);
    const lines = toRequest(cart.lines, refs.unitDecimalsOf);
    if (!lines) return setProblem(t('linesInvalid'));
    const body: Record<string, unknown> = {
      cartId: cart.cartId,
      lines,
      payments: payments(),
      ...(cart.customer && !cart.customer.isWalkIn ? { customerId: cart.customer.id } : {}),
      ...(cart.removals.length > 0 ? { removals: cart.removals } : {}),
      ...(cart.heldCartId ? { heldCartId: cart.heldCartId } : {}),
    };
    for (const [permission, id] of Object.entries(withApprovals))
      body[APPROVAL_FIELD[permission]!] = id;
    sale.mutate(body, {
      onSuccess: (result) => void afterSale(result),
      onError: (error) => {
        const rule = error instanceof ApiError ? error.details.rule : undefined;
        const permission = typeof rule === 'string' ? APPROVAL_FOR_RULE[rule] : undefined;
        if (permission && !withApprovals[permission]) {
          setAsking({
            permission,
            shortages: (error as ApiError).details.shortages as StockShortage[] | undefined,
          });
          return;
        }
        setProblem(errorText(error));
      },
    });
  };

  const afterSale = async (result: PosSaleResponse) => {
    cartStore.reset();
    const printed = await printReceipt(result.receipt, {
      language: props.state.receiptLanguage,
      i18n,
      kickDrawer: result.opensDrawer,
    });
    if (printed.outcome.printed) {
      await api
        .post(
          POS_PATHS.receiptPrinted(result.document.id),
          {},
          { idempotencyKey: crypto.randomUUID() },
        )
        .catch(() => undefined);
    }
    setDone({ sale: result, print: printed.outcome, image: printed.imageUrl });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !sale.isPending) send(approvals);
  };

  if (done) {
    return (
      <SaleDone
        result={done}
        onNew={props.onDone}
        onA4={() => {
          props.onDone();
          void navigate({
            to: '/invoices/$documentId',
            params: { documentId: done.sale.document.id },
          });
        }}
        onReprint={async () => {
          // The receipt as the server has it now: after a first print, it is marked as a copy.
          const fresh = await api.get<ReceiptData>(POS_PATHS.receipt(done.sale.document.id));
          const again = await printReceipt(fresh, {
            language: props.state.receiptLanguage,
            i18n,
            kickDrawer: false,
          });
          if (again.outcome.printed) {
            await api.post(
              POS_PATHS.receiptPrinted(done.sale.document.id),
              {},
              {
                idempotencyKey: crypto.randomUUID(),
              },
            );
          }
          setDone({ ...done, print: again.outcome, image: again.imageUrl });
        }}
      />
    );
  }

  const name = localName(i18n.language);
  return (
    <>
      <Dialog isOpen onClose={props.onClose} title={t('payment.title')}>
        <form onSubmit={submit} noValidate className={styles.payForm}>
          <div className={styles.due}>
            <span>{t('payment.due')}</span>
            <b>
              <bdi>
                {money(total)} {t('currency')}
              </bdi>
            </b>
          </div>
          <Segmented<Mode>
            label={t('payment.method')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'cash', label: cash ? name(cash) : t('payment.cash') },
              ...(card ? [{ value: 'card' as Mode, label: name(card) }] : []),
              ...(card ? [{ value: 'split' as Mode, label: t('payment.split') }] : []),
            ]}
          />
          {mode === 'cash' && (
            <>
              <TextField
                label={t('payment.tendered')}
                value={tendered}
                onChange={setTendered}
                inputMode="decimal"
                ltr
                autoFocus
                placeholder={money(total)}
              />
              <div className={styles.quick}>
                {quickTenders(total).map((amount) => (
                  <Button
                    key={amount.toString()}
                    onPress={() => setTendered(money(amount).replace(/,/g, ''))}
                  >
                    <bdi>{money(amount)}</bdi>
                  </Button>
                ))}
              </div>
              {tenderedFils !== null && tenderedFils < total && <Alert>{t('payment.short')}</Alert>}
              <div className={styles.change}>
                <span>{t('payment.change')}</span>
                <b>
                  <bdi>{money(change)}</bdi>
                </b>
              </div>
              <Note>{t('payment.drawerOpens')}</Note>
            </>
          )}
          {mode === 'split' && (
            <>
              <TextField
                label={t('payment.cashPart')}
                value={cashPart}
                onChange={setCashPart}
                inputMode="decimal"
                ltr
                autoFocus
              />
              <Note>{t('payment.cardPart', { amount: money(cardFils > 0n ? cardFils : 0n) })}</Note>
            </>
          )}
          {(mode === 'card' || mode === 'split') && (
            <>
              <Note>
                {t('payment.chargeTerminal', { amount: money(cardFils > 0n ? cardFils : 0n) })}
              </Note>
              <TextField
                label={t('payment.approvalCode')}
                value={approvalCode}
                onChange={setApprovalCode}
                ltr
                autoComplete="off"
                hint={t('payment.approvalCodeHint')}
                autoFocus={mode === 'card'}
              />
            </>
          )}
          {problem && <Alert>{problem}</Alert>}
          <DialogFooter>
            <Button onPress={props.onClose}>
              {t('payment.back')} <kbd>{t('keys.esc')}</kbd>
            </Button>
            <Button type="submit" variant="fin" busy={sale.isPending} isDisabled={!ready}>
              {t('payment.confirm')} · <bdi>{money(total)}</bdi>
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      {asking && (
        <ApprovalDialog
          permission={asking.permission}
          title={t(`approval.${asking.permission}.title`)}
          explanation={t(`approval.${asking.permission}.explain`)}
          subject={
            asking.shortages && (
              <ul className={styles.shortages}>
                {asking.shortages.map((s) => (
                  <li key={s.itemId}>
                    {name(s)} · <bdi>{s.code}</bdi> —{' '}
                    {t('approval.shortage', {
                      needed: (BigInt(s.neededMilli) / 1000n).toString(),
                      available: (BigInt(s.availableMilli) / 1000n).toString(),
                    })}
                  </li>
                ))}
              </ul>
            )
          }
          onClose={() => setAsking(null)}
          onApproved={(id) => {
            const next = { ...approvals, [asking.permission]: id };
            setApprovals(next);
            setAsking(null);
            send(next);
          }}
        />
      )}
    </>
  );
}

function SaleDone(props: {
  result: { sale: PosSaleResponse; print: PrintOutcome; image: string };
  onNew: () => void;
  onA4: () => void;
  onReprint: () => Promise<void>;
}) {
  const { t } = useTranslation('pos');
  const { sale, print, image } = props.result;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        props.onNew();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);
  return (
    <Dialog isOpen onClose={props.onNew} title={t('done.title')}>
      <div className={styles.done}>
        <CheckCircle2 className={styles.doneIcon} aria-hidden="true" />
        <p>
          {t('done.receipt')}{' '}
          <b data-testid="pos-receipt-number">
            <bdi>{sale.document.docNumber}</bdi>
          </b>
        </p>
        {BigInt(sale.changeFils) > 0n && (
          <p className={styles.doneChange}>
            {t('payment.change')}:{' '}
            <b>
              <bdi>
                {money(BigInt(sale.changeFils))} {t('currency')}
              </bdi>
            </b>
          </p>
        )}
        {sale.oversellAdjustmentNumber && (
          <Note>{t('done.oversell', { number: sale.oversellAdjustmentNumber })}</Note>
        )}
        {sale.dropDue && <Alert tone="warn">{t('dropDueLong')}</Alert>}
        {print.printed ? (
          <Note>{t('done.printed')}</Note>
        ) : (
          <>
            <Alert tone="warn">{t(`done.notPrinted.${print.reason}`)}</Alert>
            <img className={styles.preview} src={image} alt={t('done.preview')} />
          </>
        )}
      </div>
      <DialogFooter>
        <Button onPress={() => void props.onReprint()}>
          <Printer className={iconClass.sm} aria-hidden="true" />
          {t('done.reprint')}
        </Button>
        <Button onPress={props.onA4}>
          <FileText className={iconClass.sm} aria-hidden="true" />
          {t('done.a4')}
        </Button>
        <Button variant="primary" onPress={props.onNew} autoFocus>
          {t('done.newSale')} <kbd>{t('keys.enter')}</kbd>
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
