/**
 * The customer's account in the Customers detail (design 14): what they owe right now, cash or
 * credit, unused advances, the statement of account and, for the owner, the opening balance.
 */
import { useState } from 'react';
import { FileSpreadsheet, HandCoins, Landmark } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import type { CustomerDetail } from '@artepool/shared/contracts';
import { Button, Card, CardHeader, DefinitionList, iconClass } from '../../ui';
import { useCan } from '../auth/context';
import { money } from '../masterdata/format';
import { useCustomerBalance } from '../sales/api';
import { OpeningBalanceDialog } from './OpeningBalanceDialog';
import { StatementDialog } from './StatementDialog';
import styles from './receipts.module.css';

export function CustomerAccount({ customer }: { customer: CustomerDetail }) {
  const { t } = useTranslation('receipts');
  const can = useCan();
  const [dialog, setDialog] = useState<'statement' | 'opening' | null>(null);
  const balance = useCustomerBalance(customer.id);
  const b = balance.data;
  const statements = can('statements.view');
  const opening = can('customers.opening');
  const receive = can('payments.receive') && customer.isActive;
  const navigate = useNavigate();

  if (!b && !statements && !opening && !receive) return null;
  const owed = b ? BigInt(b.balanceFils) : 0n;
  return (
    <Card rise index={3}>
      <CardHeader title={t('account.title')} />
      <div className={styles.form}>
        {b && (
          <DefinitionList
            rows={[
              {
                label: owed < 0n ? t('account.weOwe') : t('account.balance'),
                value: (
                  <bdi className={owed > 0n ? styles.owes : undefined}>
                    {money(owed < 0n ? -owed : owed)}
                  </bdi>
                ),
              },
              {
                label: t('account.credit'),
                value:
                  b.creditMode === 'credit'
                    ? t('sales:customerPicker.credit', { limit: money(BigInt(b.creditLimitFils)) })
                    : t('sales:customerPicker.cash'),
              },
              {
                label: t('account.advances'),
                value: <bdi>{money(BigInt(b.advancesFils))}</bdi>,
              },
            ]}
          />
        )}
        {balance.isError && <p className={styles.muted}>{t('account.unavailable')}</p>}
        {(statements || opening || receive) && (
          <div className={styles.accountActions}>
            {receive && (
              <Button
                onPress={() =>
                  void navigate({
                    to: '/receipts/$paymentId',
                    params: { paymentId: 'new' },
                    search: { customerId: customer.id },
                  })
                }
              >
                <HandCoins className={iconClass.sm} aria-hidden="true" />
                {t('receive.button')}
              </Button>
            )}
            {statements && (
              <Button onPress={() => setDialog('statement')}>
                <FileSpreadsheet className={iconClass.sm} aria-hidden="true" />
                {t('statement.button')}
              </Button>
            )}
            {opening && (
              <Button variant="ghost" onPress={() => setDialog('opening')}>
                <Landmark className={iconClass.sm} aria-hidden="true" />
                {t('openingBalance.button')}
              </Button>
            )}
          </div>
        )}
      </div>
      {dialog === 'statement' && (
        <StatementDialog customer={customer} onClose={() => setDialog(null)} />
      )}
      {dialog === 'opening' && (
        <OpeningBalanceDialog customer={customer} onClose={() => setDialog(null)} />
      )}
    </Card>
  );
}
