/**
 * A customer's opening balance at go-live (decision 0051): owner only, entered once. What the
 * customer owed us (receivable) or we owed them (payable); later changes are credit or debit notes.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { OpeningBalanceItem, OpeningBalanceRequest } from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { useSave } from '../../api/hooks';
import { dubaiDay, formatDate } from '../../lib/format';
import {
  Alert,
  Button,
  DefinitionList,
  Dialog,
  DialogFooter,
  EmptyState,
  InfoBar,
  Segmented,
  TextField,
  useToast,
} from '../../ui';
import { useErrorText } from '../auth/context';
import { money } from '../masterdata/format';
import { SALES_INVALIDATE, SALES_PATHS } from '../sales/api';
import { readFils, type AmountProblem } from './allocation';
import { openingKey, useOpeningBalance } from './api';
import styles from './receipts.module.css';

type Direction = OpeningBalanceRequest['direction'];

function Existing({ balance }: { balance: OpeningBalanceItem }) {
  const { t } = useTranslation('receipts');
  return (
    <>
      <DefinitionList
        rows={[
          { label: t('openingBalance.date'), value: <bdi>{formatDate(balance.balanceDate)}</bdi> },
          {
            label: t('openingBalance.direction'),
            value: t(`openingBalance.directions.${balance.direction}`),
          },
          {
            label: t('sales:fields.amount'),
            value: <bdi>{money(BigInt(balance.amountFils))}</bdi>,
          },
          {
            label: t('openingBalance.settled'),
            value: <bdi>{money(BigInt(balance.settledFils))}</bdi>,
          },
          ...(balance.reference
            ? [{ label: t('sales:fields.reference'), value: <bdi>{balance.reference}</bdi> }]
            : []),
        ]}
      />
      <InfoBar>{t('openingBalance.onceOnly')}</InfoBar>
    </>
  );
}

export function OpeningBalanceDialog(props: {
  customer: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useTranslation('receipts');
  const errorText = useErrorText();
  const toast = useToast();
  const existing = useOpeningBalance(props.customer.id);
  const [direction, setDirection] = useState<Direction>('receivable');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => dubaiDay());
  const [reference, setReference] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [amountProblem, setAmountProblem] = useState<AmountProblem | null>(null);

  const save = useSave(
    (api, body: OpeningBalanceRequest, key) =>
      api.post<OpeningBalanceItem>(SALES_PATHS.openingBalances, body, { idempotencyKey: key }),
    {
      invalidate: [...SALES_INVALIDATE, openingKey(props.customer.id)],
      onSuccess: () => {
        toast(t('openingBalance.saved'));
        props.onClose();
      },
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.reset();
    const read = readFils(amount);
    if (!read.ok) return setAmountProblem(read.problem);
    setAmountProblem(null);
    save.mutate({
      customerId: props.customer.id,
      direction,
      amountFils: read.value.toString(),
      balanceDate: date,
      ...(reference.trim() ? { reference: reference.trim() } : {}),
      ...(direction === 'receivable' && dueDate ? { dueDate } : {}),
    });
  };

  const duplicate = save.error instanceof ApiError && save.error.code === 'DUPLICATE';
  const balance = existing.data;
  return (
    <Dialog isOpen onClose={props.onClose} title={t('openingBalance.title')}>
      <form onSubmit={submit} noValidate className={styles.form}>
        <b>{props.customer.name}</b>
        {existing.isLoading && <EmptyState>{t('sales:loading')}</EmptyState>}
        {existing.isError && <Alert>{errorText(existing.error)}</Alert>}
        {balance && <Existing balance={balance} />}
        {existing.isSuccess && balance === null && (
          <>
            <InfoBar>{t('openingBalance.explain')}</InfoBar>
            <Segmented<Direction>
              label={t('openingBalance.direction')}
              value={direction}
              onChange={setDirection}
              block
              options={[
                { value: 'receivable', label: t('openingBalance.directions.receivable') },
                { value: 'payable', label: t('openingBalance.directions.payable') },
              ]}
            />
            <TextField
              label={t('sales:fields.amount')}
              value={amount}
              onChange={setAmount}
              inputMode="numeric"
              autoComplete="off"
              ltr
              size="lg"
              isRequired
              error={amountProblem ? t(`problems.${amountProblem}`) : undefined}
            />
            <div className={styles.fields}>
              <label className={styles.dateField}>
                <span>{t('openingBalance.date')}</span>
                <input
                  type="date"
                  dir="ltr"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
              {direction === 'receivable' && (
                <label className={styles.dateField}>
                  <span>{t('sales:fields.dueDate')}</span>
                  <input
                    type="date"
                    dir="ltr"
                    value={dueDate}
                    onChange={(event) => setDueDate(event.target.value)}
                  />
                </label>
              )}
            </div>
            <TextField
              label={t('sales:fields.reference')}
              value={reference}
              onChange={setReference}
              maxLength={100}
            />
          </>
        )}
        {save.error !== null && (
          <Alert>{duplicate ? t('openingBalance.duplicate') : errorText(save.error)}</Alert>
        )}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('openingBalance.close')}</Button>
          {existing.isSuccess && balance === null && (
            <Button type="submit" variant="primary" busy={save.isPending}>
              {t('openingBalance.save')}
            </Button>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}
