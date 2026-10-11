import { useState } from 'react';
import { Ban, Banknote, CreditCard, Lock, Pencil, Store, Undo2, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CustomerDetail } from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import {
  Alert,
  Button,
  Card,
  Chip,
  DefinitionList,
  iconClass,
  Note,
  Tile,
  useToast,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { DeactivateDialog } from '../masterdata/DeactivateDialog';
import { money } from '../masterdata/format';
import { MD_KEYS } from '../masterdata/refs';
import { customerPath } from './api';
import { CreditDialog } from './CreditDialog';
import { CUSTOMER_TYPE_ICONS, CustomerDialog } from './CustomerDialog';
import { isStale, partiesClasses as styles, Phone, StaleNotice, useTermsText } from './parts';

/** Cash or credit, as a chip (status = text + icon + colour). */
export function CreditChip({ mode }: { mode: CustomerDetail['creditMode'] }) {
  const { t } = useTranslation('parties');
  return mode === 'credit' ? (
    <Chip tone="credit" icon={<CreditCard aria-hidden="true" />}>
      {t('credit.credit')}
    </Chip>
  ) : (
    <Chip icon={<Banknote aria-hidden="true" />}>{t('credit.cash')}</Chip>
  );
}

/**
 * The selected customer's details (design 14, without the balance parts that arrive in M4):
 * contact details, which tax invoice they get, cash or credit, and the buttons the person may use.
 */
export function CustomerCard(props: {
  customer: CustomerDetail;
  onReload: () => Promise<CustomerDetail | null>;
}) {
  const { t } = useTranslation(['parties', 'masterdata']);
  const can = useCan();
  const errorText = useErrorText();
  const toast = useToast();
  const termsText = useTermsText();
  const c = props.customer;
  const [dialog, setDialog] = useState<'edit' | 'credit' | 'deactivate' | null>(null);
  const manage = can('customers.manage') && !c.isWalkIn;
  const giveCredit = can('customers.credit') && !c.isWalkIn && c.isActive;

  const deactivate = useSave(
    (api, input: { reason: string; rowVersion: number }, key) =>
      api.post<CustomerDetail>(customerPath(c.id, '/deactivate'), input, {
        idempotencyKey: key,
      }),
    {
      invalidate: [MD_KEYS.customers],
      onSuccess: () => {
        toast(t('masterdata:deactivated'));
        setDialog(null);
      },
    },
  );
  const reactivate = useSave(
    (api, input: { rowVersion: number }, key) =>
      api.post<CustomerDetail>(customerPath(c.id, '/reactivate'), input, {
        idempotencyKey: key,
      }),
    { invalidate: [MD_KEYS.customers], onSuccess: () => toast(t('masterdata:reactivated')) },
  );
  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    setReloading(true);
    try {
      await props.onReload();
      deactivate.reset();
      reactivate.reset();
    } finally {
      setReloading(false);
    }
  };

  const staleAction = [deactivate.error, reactivate.error].find(isStale);
  const otherError = reactivate.error !== null && !isStale(reactivate.error);
  const none = t('masterdata:none');
  const text = (value: string | null) => value ?? none;

  const rows = [
    {
      label: t('parties:detail.invoiceType'),
      value: c.isVatRegistered ? t('parties:vat.fullInvoice') : t('parties:vat.simplifiedInvoice'),
    },
    ...(c.trn ? [{ label: t('parties:detail.trn'), value: <bdi>{c.trn}</bdi> }] : []),
    ...(c.nameAlt ? [{ label: t('parties:detail.nameAlt'), value: c.nameAlt }] : []),
    { label: t('parties:detail.code'), value: <bdi>{c.code}</bdi> },
    ...(c.isWalkIn
      ? []
      : [
          { label: t('parties:detail.phone'), value: <Phone value={c.phone} /> },
          ...(c.phoneAlt
            ? [{ label: t('parties:detail.phoneAlt'), value: <Phone value={c.phoneAlt} /> }]
            : []),
          {
            label: t('parties:detail.email'),
            value: c.email ? <bdi>{c.email}</bdi> : none,
          },
          { label: t('parties:detail.address'), value: text(c.addressLine) },
          { label: t('parties:detail.area'), value: text(c.area) },
          { label: t('parties:detail.city'), value: text(c.city) },
          ...(c.poBox ? [{ label: t('parties:detail.poBox'), value: <bdi>{c.poBox}</bdi> }] : []),
          {
            label: t('parties:detail.emirate'),
            value: c.emirate ? t(`masterdata:emirates.${c.emirate}`) : none,
          },
          {
            label: t('parties:detail.language'),
            value: t(`parties:languages.${c.preferredLanguage ?? 'none'}`),
          },
        ]),
  ];

  return (
    <Card rise index={2} className={styles.sec}>
      <div className={styles.head}>
        <div className={styles.who}>
          <Tile>
            {c.isWalkIn ? <Store aria-hidden="true" /> : CUSTOMER_TYPE_ICONS[c.customerType]}
          </Tile>
          <span>
            <h2 className={styles.name}>{c.name}</h2>
            <span className={styles.sub}>
              {c.isWalkIn ? t('parties:types.walkIn') : t(`parties:types.${c.customerType}`)}
            </span>
          </span>
        </div>
        {!c.isActive && (
          <Chip icon={<Ban aria-hidden="true" />}>{t('masterdata:status.inactive')}</Chip>
        )}
      </div>

      {!c.isActive && (
        <div className={styles.offbar}>
          <Ban aria-hidden="true" />
          <span>{t('parties:customers.deactivatedBar')}</span>
        </div>
      )}
      {c.isWalkIn && (
        <div className={styles.offbar}>
          <Lock aria-hidden="true" />
          <span>{t('parties:customers.walkInNote')}</span>
        </div>
      )}
      {staleAction !== undefined && <StaleNotice onReload={() => void reload()} busy={reloading} />}
      {otherError && <Alert>{errorText(reactivate.error)}</Alert>}

      <DefinitionList rows={rows} />

      {c.notes && (
        <div className={styles.section}>
          <h3 className={styles.fieldLabel}>{t('parties:detail.notes')}</h3>
          <p className={styles.notes}>{c.notes}</p>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h3>{t('parties:detail.credit')}</h3>
          <CreditChip mode={c.creditMode} />
        </div>
        {c.creditMode === 'credit' ? (
          <DefinitionList
            rows={[
              {
                label: t('parties:detail.creditLimit'),
                value: (
                  <>
                    <bdi>{money(BigInt(c.creditLimitFils))}</bdi> {t('parties:aed')}
                  </>
                ),
              },
              { label: t('parties:detail.terms'), value: termsText(c.paymentTermsDays) },
            ]}
          />
        ) : (
          <Note>{t('parties:detail.cashNote')}</Note>
        )}
        {giveCredit && (
          <div className={styles.acts}>
            <Button onPress={() => setDialog('credit')}>
              <Wallet className={iconClass.sm} aria-hidden="true" />
              {t('parties:customers.changeCredit')}
            </Button>
          </div>
        )}
      </div>

      {manage && (
        <div className={styles.acts}>
          {c.isActive && (
            <Button onPress={() => setDialog('edit')}>
              <Pencil className={iconClass.sm} aria-hidden="true" />
              {t('masterdata:actions.edit')}
            </Button>
          )}
          {c.isActive ? (
            <Button
              variant="dangerGhost"
              onPress={() => {
                deactivate.reset();
                setDialog('deactivate');
              }}
            >
              <Ban className={iconClass.sm} aria-hidden="true" />
              {t('parties:customers.deactivate')}
            </Button>
          ) : (
            <Button
              busy={reactivate.isPending}
              onPress={() => reactivate.mutate({ rowVersion: c.rowVersion })}
            >
              <Undo2 className={iconClass.sm} aria-hidden="true" />
              {t('masterdata:actions.reactivate')}
            </Button>
          )}
        </div>
      )}

      {dialog === 'edit' && (
        <CustomerDialog
          customer={c}
          onReload={props.onReload}
          onClose={() => setDialog(null)}
          onSaved={() => setDialog(null)}
        />
      )}
      {dialog === 'credit' && (
        <CreditDialog customer={c} onReload={props.onReload} onClose={() => setDialog(null)} />
      )}
      {dialog === 'deactivate' && (
        <DeactivateDialog
          title={t('parties:customers.deactivateTitle')}
          subject={<b>{c.name}</b>}
          explanation={t('parties:customers.deactivateExplain')}
          busy={deactivate.isPending}
          error={deactivate.error !== null && !isStale(deactivate.error) ? deactivate.error : null}
          onConfirm={(reason) =>
            deactivate.mutate(
              { reason, rowVersion: c.rowVersion },
              { onError: (error) => isStale(error) && setDialog(null) },
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  );
}
