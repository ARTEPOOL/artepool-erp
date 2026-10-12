/**
 * Choosing the customer of a sales document: search by name, phone or TRN. Once chosen, the card
 * shows what decides the document — the invoice format (decision 0010: registered → full tax
 * invoice with the TRN), cash or credit (decision 0046) and the current balance.
 */
import { useEffect, useState } from 'react';
import { Search, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CustomerListItem } from '@artepool/shared/contracts';
import { Button, iconClass } from '../../ui';
import { money } from '../masterdata/format';
import { useCustomerBalance, useCustomerSearch } from './api';
import styles from './sales.module.css';

/** What a document remembers about its customer (enough to show the card again). */
export interface ChosenCustomer {
  id: string;
  name: string;
  phone: string | null;
  trn: string | null;
  isVatRegistered: boolean;
}

export const chosenFrom = (c: CustomerListItem): ChosenCustomer => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  trn: c.trn,
  isVatRegistered: c.isVatRegistered,
});

export function CustomerPicker(props: {
  value: ChosenCustomer | null;
  onChange: (customer: ChosenCustomer | null) => void;
  /** Locked once the document is saved with lines that depend on it. */
  disabled?: boolean;
  /** Show cash/credit and the balance (invoices and receipts). */
  showBalance?: boolean;
}) {
  const { t } = useTranslation('sales');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const found = useCustomerSearch(props.value ? '' : q);
  const balance = useCustomerBalance(props.showBalance && props.value ? props.value.id : null);

  if (props.value) {
    const c = props.value;
    const b = balance.data;
    return (
      <div className={styles.chosenCustomer} aria-label={t('fields.customer')} role="group">
        <div className={styles.form}>
          <b>{c.name}</b>
          <div className={styles.customerFacts}>
            {c.phone && <bdi>{c.phone}</bdi>}
            {c.trn && <span>{t('customerPicker.trn', { trn: c.trn })}</span>}
            <span>{t(c.isVatRegistered ? 'formats.full' : 'formats.simplified')}</span>
            {b && (
              <>
                <span>
                  {b.creditMode === 'credit'
                    ? t('customerPicker.credit', { limit: money(BigInt(b.creditLimitFils)) })
                    : t('customerPicker.cash')}
                </span>
                <span>{t('customerPicker.balance', { amount: money(BigInt(b.balanceFils)) })}</span>
              </>
            )}
          </div>
        </div>
        {!props.disabled && (
          <Button variant="ghost" onPress={() => props.onChange(null)}>
            {t('customerPicker.change')}
          </Button>
        )}
      </div>
    );
  }

  const choices = found.data?.customers ?? [];
  return (
    <div className={styles.picker}>
      <label className={styles.pickSearch}>
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label={t('customerPicker.search')}
          placeholder={t('customerPicker.search')}
          value={text}
          disabled={props.disabled}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      {q && (
        <ul className={styles.choices} aria-label={t('customerPicker.results')}>
          {choices.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  props.onChange(chosenFrom(c));
                  setText('');
                  setQ('');
                }}
              >
                <UserRound className={iconClass.sm} aria-hidden="true" />
                <span className={styles.choiceMain}>
                  <span>{c.name}</span>
                  <span className={styles.muted}>
                    <bdi>{c.phone ?? c.code}</bdi>
                    {c.trn && (
                      <>
                        {' · '}
                        <bdi>{c.trn}</bdi>
                      </>
                    )}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {!found.isFetching && choices.length === 0 && (
            <li className={styles.muted}>{t('customerPicker.none')}</li>
          )}
        </ul>
      )}
    </div>
  );
}
