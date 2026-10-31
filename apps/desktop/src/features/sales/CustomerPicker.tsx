/**
 * Choosing the customer of a sales document: search by name, phone or TRN. Once chosen, the card
 * shows what decides the document — the invoice format (decision 0010: registered → full tax
 * invoice with the TRN), cash or credit (decision 0046) and the balance banner (decision 0114).
 */
import { useState } from 'react';
import { Search, UserPlus, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CustomerListItem } from '@artepool/shared/contracts';
import { Button, iconClass } from '../../ui';
import { useCan } from '../auth/context';
import { CustomerDialog } from '../customers/CustomerDialog';
import { useCustomerBalance, useCustomerSearch } from './api';
import { BalanceBanner } from './CustomerBalanceBanner';
import { useSuggest } from './suggest';
import styles from './sales.module.css';

/** What a document remembers about its customer (enough to show the card again). */
export interface ChosenCustomer {
  id: string;
  name: string;
  phone: string | null;
  trn: string | null;
  isVatRegistered: boolean;
  /** The shared "cash customer" for sales without a named customer. */
  isWalkIn?: boolean;
}

export const chosenFrom = (c: CustomerListItem): ChosenCustomer => ({
  id: c.id,
  name: c.name,
  phone: c.phone,
  trn: c.trn,
  isVatRegistered: c.isVatRegistered,
  isWalkIn: c.isWalkIn,
});

/** The shared cash customer, chosen by default on a new invoice. */
export function useWalkInCustomer(): ChosenCustomer | null {
  const found = useCustomerSearch('', true);
  const walkIn = found.data?.customers.find((c) => c.isWalkIn);
  return walkIn ? chosenFrom(walkIn) : null;
}

export function CustomerPicker(props: {
  value: ChosenCustomer | null;
  onChange: (customer: ChosenCustomer | null) => void;
  /** Locked once the document is saved with lines that depend on it. */
  disabled?: boolean;
  /** Show cash/credit and the balance (invoices and receipts). */
  showBalance?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation('sales');
  const can = useCan();
  const box = useSuggest();
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState(false);
  const found = useCustomerSearch(box.q, !props.value && (box.open || box.q.length > 0));
  const choose = (c: ChosenCustomer) => {
    props.onChange(c);
    box.reset();
  };
  const balance = useCustomerBalance(
    props.showBalance && props.value && !props.value.isWalkIn ? props.value.id : null,
  );

  if (props.value) {
    const c = props.value;
    const b = balance.data;
    return (
      <div className={styles.chosenCustomer} aria-label={t('fields.customer')} role="group">
        <div className={styles.form}>
          <b>{c.isWalkIn ? t('customerPicker.walkIn') : c.name}</b>
          <div className={styles.customerFacts}>
            {c.phone && <bdi>{c.phone}</bdi>}
            {c.trn && <span>{t('customerPicker.trn', { trn: c.trn })}</span>}
            <span>{t(c.isVatRegistered ? 'formats.full' : 'formats.simplified')}</span>
            {b && !c.isWalkIn && (
              <span>
                {t(b.creditMode === 'credit' ? 'customerPicker.creditOnly' : 'customerPicker.cash')}
              </span>
            )}
          </div>
        </div>
        {!props.disabled && (
          <Button
            variant="ghost"
            onPress={() => {
              setChanging(true);
              props.onChange(null);
            }}
          >
            {t('customerPicker.change')}
          </Button>
        )}
        {b && <BalanceBanner balance={b} />}
      </div>
    );
  }

  const choices = found.data?.customers ?? [];
  return (
    <div className={styles.picker} {...box.container}>
      <label className={styles.pickSearch}>
        <Search aria-hidden="true" />
        <input
          type="search"
          aria-label={t('customerPicker.search')}
          placeholder={t('customerPicker.search')}
          autoComplete="off"
          // After "Change customer" the list opens straight away.
          autoFocus={props.autoFocus || changing}
          aria-expanded={box.open}
          disabled={props.disabled}
          {...box.input}
        />
      </label>
      {box.open && (
        <ul className={styles.choices} aria-label={t('customerPicker.results')} ref={box.listRef}>
          {choices.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => choose(chosenFrom(c))}>
                <UserRound className={iconClass.sm} aria-hidden="true" />
                <span className={styles.choiceMain}>
                  <span>{c.isWalkIn ? t('customerPicker.walkIn') : c.name}</span>
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
          {can('customers.manage') && (
            <li>
              <button type="button" onClick={() => setAdding(true)}>
                <UserPlus className={iconClass.sm} aria-hidden="true" />
                <span className={styles.choiceMain}>{t('customerPicker.add')}</span>
              </button>
            </li>
          )}
        </ul>
      )}
      {adding && (
        <CustomerDialog
          customer={null}
          onClose={() => setAdding(false)}
          onSaved={(saved) => {
            setAdding(false);
            choose(chosenFrom(saved));
          }}
        />
      )}
    </div>
  );
}
