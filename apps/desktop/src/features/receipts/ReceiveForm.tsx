/**
 * Receiving a payment from a customer (decisions 0013, 0047, 0048, 0052). The amount settles the
 * oldest open debts first, or the amounts chosen; the rest is an advance, and the server issues
 * its payment tax invoice (INV-) in the same transaction. The preview here uses exact integers.
 */
import { useState, type FormEvent } from 'react';
import { ArrowLeft, HandCoins } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type {
  ReceivePaymentRequest,
  ReceivePaymentResponse,
  SalesPaymentMethod,
} from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import { dubaiDay, formatDate } from '../../lib/format';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  cx,
  EmptyState,
  iconClass,
  InfoBar,
  pageClasses,
  PageHeader,
  Segmented,
  SelectField,
  tableClasses as tbl,
  TextField,
  useToast,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { money } from '../masterdata/format';
import { localName, useVat } from '../masterdata/refs';
import {
  SALES_INVALIDATE,
  SALES_KEYS,
  SALES_PATHS,
  useQuotations,
  useSalesPaymentMethods,
} from '../sales/api';
import { CustomerPicker, type ChosenCustomer } from '../sales/CustomerPicker';
import {
  advanceVat,
  autoSpread,
  manualSpread,
  readFils,
  type AmountProblem,
  type ShareProblem,
  type Spread,
} from './allocation';
import { useOpenDebts } from './api';
import { useKindText } from './parts';
import salesStyles from '../sales/sales.module.css';
import styles from './receipts.module.css';

type Mode = 'auto' | 'manual' | 'advance';

interface Problems {
  customer?: 'required';
  method?: 'required';
  amount?: AmountProblem;
  reference?: 'required';
  chequeDate?: 'required';
  chequeBank?: 'required';
  over?: true;
  shares?: true;
}

/** The standard VAT rate (SR, 5%) the server uses for an advance unless told otherwise. */
const DEFAULT_RATE_BP = 500;

export function ReceiveForm() {
  const { t, i18n } = useTranslation('receipts');
  const name = localName(i18n.language);
  const can = useCan();
  const errorText = useErrorText();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const kindText = useKindText();
  const methods = useSalesPaymentMethods();
  const vat = useVat();

  const [customer, setCustomer] = useState<ChosenCustomer | null>(null);
  const [date, setDate] = useState(() => dubaiDay());
  const [methodId, setMethodId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [chequeDate, setChequeDate] = useState('');
  const [chequeBank, setChequeBank] = useState('');
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState<Mode>('auto');
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [quotationId, setQuotationId] = useState('');
  const [tried, setTried] = useState(false);

  const open = useOpenDebts(customer?.id ?? null);
  const canQuotations = can('quotations.manage') && customer !== null;
  const accepted = useQuotations({ customerId: customer?.id, status: 'accepted' }, canQuotations);
  const sent = useQuotations({ customerId: customer?.id, status: 'sent' }, canQuotations);
  const quotations = [...(accepted.data?.quotations ?? []), ...(sent.data?.quotations ?? [])];

  const activeMethods: SalesPaymentMethod[] = methods.data ?? [];
  const method = activeMethods.find((m) => m.id === methodId) ?? activeMethods[0];
  const isCheque = method?.kind === 'cheque';
  const rateBp = vat.data?.categories.find((c) => c.code === 'SR')?.rateBp ?? DEFAULT_RATE_BP;

  const read = readFils(amount);
  const amountFils = read.ok ? read.value : 0n;
  const debts = open.debts;
  const manual = manualSpread(amountFils, debts, typed);
  const spread: Spread =
    mode === 'advance'
      ? { shares: [], settledFils: 0n, advanceFils: amountFils }
      : mode === 'manual'
        ? manual.spread
        : autoSpread(amountFils, debts);
  const shareOf = (key: string) => spread.shares.find((s) => s.debt.key === key)?.amountFils;

  const problems: Problems = {};
  if (!customer) problems.customer = 'required';
  if (!method) problems.method = 'required';
  if (!read.ok) problems.amount = read.problem;
  if ((isCheque || method?.requiresReference) && !reference.trim()) problems.reference = 'required';
  if (isCheque && !chequeDate) problems.chequeDate = 'required';
  if (isCheque && !chequeBank.trim()) problems.chequeBank = 'required';
  if (mode === 'manual' && manual.over) problems.over = true;
  if (mode === 'manual' && Object.keys(manual.problems).length > 0) problems.shares = true;
  const shown = <K extends keyof Problems>(key: K): Problems[K] =>
    tried ? problems[key] : undefined;

  const receive = useSave(
    (api, body: ReceivePaymentRequest, key) =>
      api.post<ReceivePaymentResponse>(SALES_PATHS.payments, body, { idempotencyKey: key }),
    {
      invalidate: SALES_INVALIDATE,
      onSuccess: (result) => {
        queryClient.setQueryData(SALES_KEYS.payment(result.payment.id), result.payment);
        toast(
          result.advanceInvoice
            ? t('receive.doneAdvance', {
                number: result.payment.docNumber,
                invoice: result.advanceInvoice.docNumber ?? '',
              })
            : t('receive.done', { number: result.payment.docNumber }),
        );
        void navigate({ to: '/receipts/$paymentId', params: { paymentId: result.payment.id } });
      },
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    receive.reset();
    if (Object.keys(problems).length > 0 || !customer || !method || !read.ok) return;
    const part: ReceivePaymentRequest['part'] = {
      paymentMethodId: method.id,
      amountFils: read.value.toString(),
      ...(reference.trim() ? { reference: reference.trim() } : {}),
      ...(isCheque ? { chequeDate, chequeBank: chequeBank.trim() } : {}),
    };
    const body: ReceivePaymentRequest = { customerId: customer.id, paymentDate: date, part };
    if (mode === 'manual' && spread.shares.length > 0) {
      body.allocations = spread.shares.map((s) => ({
        ...(s.debt.documentId
          ? { documentId: s.debt.documentId }
          : { openingBalanceId: s.debt.openingBalanceId! }),
        amountFils: s.amountFils.toString(),
      }));
    }
    // Manual with nothing chosen settles nothing: without allocations the server would spread it.
    if (mode === 'advance' || (mode === 'manual' && spread.shares.length === 0))
      body.asAdvance = true;
    if (quotationId && spread.advanceFils > 0n) body.quotationId = quotationId;
    if (notes.trim()) body.notes = notes.trim();
    receive.mutate(body);
  };

  const amountText = (problem: AmountProblem | undefined) =>
    problem ? t(`problems.${problem}`) : undefined;
  const required = (problem: 'required' | undefined) =>
    problem ? t('problems.required') : undefined;
  const shareProblem = (problem: ShareProblem | undefined) =>
    problem ? t(`problems.${problem}`) : undefined;

  const back = (
    <Link to="/receipts" className={styles.backLink}>
      <ArrowLeft className={cx(iconClass.sm, styles.flip)} aria-hidden="true" />
      {t('back')}
    </Link>
  );

  return (
    <div className={pageClasses.page}>
      <PageHeader title={t('receive.title')} subtitle={t('receive.subtitle')} tools={back} />
      <form onSubmit={submit} noValidate className={styles.page}>
        <Card rise index={1}>
          <CardHeader title={t('sales:fields.customer')} />
          <div className={salesStyles.cardBody}>
            <CustomerPicker
              value={customer}
              onChange={(c) => {
                setCustomer(c);
                setTyped({});
                setQuotationId('');
              }}
              showBalance
            />
            {shown('customer') && (
              <span className={salesStyles.fieldError}>{t('problems.customer')}</span>
            )}
          </div>
        </Card>

        <Card rise index={2}>
          <CardHeader title={t('receive.payment')} />
          <div className={salesStyles.cardBody}>
            <div className={styles.fields}>
              <label className={styles.dateField}>
                <span>{t('sales:fields.date')}</span>
                <input
                  type="date"
                  dir="ltr"
                  value={date}
                  max={dubaiDay()}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
              <SelectField
                id="receive-method"
                label={t('sales:fields.method')}
                value={method?.id ?? ''}
                onChange={setMethodId}
                options={activeMethods.map((m) => ({ value: m.id, label: name(m) }))}
              />
              <TextField
                label={t('receive.amount')}
                value={amount}
                onChange={setAmount}
                inputMode="numeric"
                autoComplete="off"
                ltr
                size="lg"
                isRequired
                error={amountText(shown('amount'))}
              />
            </div>
            {shown('method') && (
              <span className={salesStyles.fieldError}>{t('problems.method')}</span>
            )}
            <div className={styles.fields}>
              <TextField
                label={isCheque ? t('receive.chequeNumber') : t('sales:fields.reference')}
                value={reference}
                onChange={setReference}
                autoComplete="off"
                ltr
                maxLength={100}
                isRequired={isCheque || method?.requiresReference}
                error={required(shown('reference'))}
              />
              {isCheque && (
                <>
                  <div className={styles.dateField}>
                    <label htmlFor="receive-cheque-date">{t('receive.chequeDate')}</label>
                    <input
                      id="receive-cheque-date"
                      type="date"
                      dir="ltr"
                      value={chequeDate}
                      aria-invalid={shown('chequeDate') ? true : undefined}
                      onChange={(event) => setChequeDate(event.target.value)}
                    />
                    {shown('chequeDate') && (
                      <span className={salesStyles.fieldError}>{t('problems.required')}</span>
                    )}
                  </div>
                  <TextField
                    label={t('receive.chequeBank')}
                    value={chequeBank}
                    onChange={setChequeBank}
                    maxLength={100}
                    isRequired
                    error={required(shown('chequeBank'))}
                  />
                </>
              )}
            </div>
            {isCheque && <InfoBar>{t('receive.chequeNote')}</InfoBar>}
            <TextField
              label={t('sales:fields.notes')}
              value={notes}
              onChange={setNotes}
              maxLength={1000}
              multiline
            />
          </div>
        </Card>

        <Card rise index={3} padding="table">
          <CardHeader title={t('receive.allocation')}>
            <Segmented<Mode>
              label={t('receive.allocation')}
              value={mode}
              onChange={setMode}
              options={[
                { value: 'auto', label: t('receive.modes.auto') },
                { value: 'manual', label: t('receive.modes.manual') },
                { value: 'advance', label: t('receive.modes.advance') },
              ]}
            />
          </CardHeader>
          <div className={salesStyles.cardBody}>
            <p className={styles.muted}>{t(`receive.modeHint.${mode}`)}</p>
            {customer === null ? (
              <EmptyState>{t('receive.chooseCustomer')}</EmptyState>
            ) : mode !== 'advance' ? (
              <>
                <div className={styles.tableWrap}>
                  <table className={tbl.table} aria-label={t('receive.openDebts')}>
                    <thead>
                      <tr>
                        <th>{t('sales:fields.number')}</th>
                        <th>{t('receive.type')}</th>
                        <th>{t('sales:fields.date')}</th>
                        <th className={tbl.num}>{t('sales:fields.total')}</th>
                        <th className={tbl.num}>{t('sales:fields.due')}</th>
                        <th className={tbl.num}>{t('receive.applied')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {debts.map((d) => {
                        const label = d.docNumber ?? kindText(d.docType);
                        const problem = manual.problems[d.key];
                        const share = shareOf(d.key);
                        return (
                          <tr
                            key={d.key}
                            className={cx(mode === 'manual' && problem && styles.badRow)}
                          >
                            <td className={styles.numberCell}>
                              <bdi>{label}</bdi>
                            </td>
                            <td>{kindText(d.docType)}</td>
                            <td>{d.date ? <bdi>{formatDate(d.date)}</bdi> : '—'}</td>
                            <td className={tbl.num}>
                              <bdi>{money(d.totalFils)}</bdi>
                            </td>
                            <td className={tbl.num}>
                              <bdi>{money(d.dueFils)}</bdi>
                            </td>
                            <td className={tbl.num}>
                              {mode === 'manual' ? (
                                <>
                                  <input
                                    className={cx(
                                      salesStyles.cellInput,
                                      problem && salesStyles.bad,
                                    )}
                                    dir="ltr"
                                    inputMode="decimal"
                                    autoComplete="off"
                                    aria-label={t('receive.applyTo', { number: label })}
                                    aria-invalid={problem ? true : undefined}
                                    value={typed[d.key] ?? ''}
                                    onChange={(event) =>
                                      setTyped((all) => ({ ...all, [d.key]: event.target.value }))
                                    }
                                  />
                                  {problem && (
                                    <span className={salesStyles.fieldError}>
                                      {shareProblem(problem)}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <bdi>{share !== undefined ? money(share) : '—'}</bdi>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {open.isLoading && (
                        <tr className={tbl.empty}>
                          <td colSpan={6}>{t('sales:loading')}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {open.error !== null && <Alert>{errorText(open.error)}</Alert>}
                {!open.isLoading && open.error === null && debts.length === 0 && (
                  <EmptyState>{t('receive.nothingOwed')}</EmptyState>
                )}
              </>
            ) : null}

            {customer !== null &&
              (spread.advanceFils > 0n || mode === 'advance') &&
              canQuotations && (
                <SelectField
                  id="receive-quotation"
                  label={t('receive.quotation')}
                  value={quotationId}
                  onChange={setQuotationId}
                  options={[
                    { value: '', label: t('receive.noQuotation') },
                    ...quotations.map((q) => ({
                      value: q.id,
                      label: `${q.docNumber} · ${t(`sales:quotationStatuses.${q.status}`)} · ${money(BigInt(q.totalFils))}`,
                    })),
                  ]}
                />
              )}

            <dl className={salesStyles.totals} data-testid="receive-preview">
              <div>
                <dt>{t('receive.preview.amount')}</dt>
                <dd>
                  <bdi>{money(amountFils)}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t('receive.preview.settles')}</dt>
                <dd>
                  <bdi>{money(spread.settledFils)}</bdi>
                </dd>
              </div>
              <div>
                <dt>{t('receive.preview.advance')}</dt>
                <dd>
                  <bdi>{money(spread.advanceFils)}</bdi>
                </dd>
              </div>
              {spread.advanceFils > 0n && (
                <div>
                  <dt>{t('receive.preview.advanceVat')}</dt>
                  <dd>
                    <bdi>{money(advanceVat(spread.advanceFils, rateBp))}</bdi>
                  </dd>
                </div>
              )}
            </dl>
            {spread.advanceFils > 0n && <InfoBar>{t('receive.advanceExplain')}</InfoBar>}
            {shown('over') && <Alert>{t('problems.over')}</Alert>}
            {shown('shares') && <Alert>{t('problems.shares')}</Alert>}
            {receive.error !== null && <Alert>{errorText(receive.error)}</Alert>}
            <div className={salesStyles.actions}>
              <Button type="submit" variant="fin" size="lg" busy={receive.isPending}>
                <HandCoins className={iconClass.sm} aria-hidden="true" />
                {t('receive.submit', { amount: money(amountFils) })}
              </Button>
            </div>
          </div>
        </Card>
      </form>
    </div>
  );
}
