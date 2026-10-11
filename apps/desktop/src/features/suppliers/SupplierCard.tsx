import { useState } from 'react';
import { Ban, Pencil, Truck, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SupplierDetail } from '@artepool/shared/contracts';
import { useSave } from '../../api/hooks';
import { Alert, Button, Card, Chip, DefinitionList, iconClass, Tile, useToast } from '../../ui';
import { useErrorText } from '../auth/context';
import {
  isStale,
  partiesClasses as styles,
  Phone,
  StaleNotice,
  useTermsText,
} from '../customers/parts';
import { DeactivateDialog } from '../masterdata/DeactivateDialog';
import { MD_KEYS } from '../masterdata/refs';
import { supplierPath } from './api';
import { SupplierDialog } from './SupplierDialog';

/** The selected supplier's details, with Edit and Deactivate / Reactivate. */
export function SupplierCard(props: {
  supplier: SupplierDetail;
  onReload: () => Promise<SupplierDetail | null>;
}) {
  const { t } = useTranslation(['parties', 'masterdata']);
  const errorText = useErrorText();
  const toast = useToast();
  const termsText = useTermsText();
  const s = props.supplier;
  const [dialog, setDialog] = useState<'edit' | 'deactivate' | null>(null);
  const [reloading, setReloading] = useState(false);

  const deactivate = useSave(
    (api, input: { reason: string; rowVersion: number }, key) =>
      api.post<SupplierDetail>(supplierPath(s.id, '/deactivate'), input, {
        idempotencyKey: key,
      }),
    {
      invalidate: [MD_KEYS.suppliers],
      onSuccess: () => {
        toast(t('masterdata:deactivated'));
        setDialog(null);
      },
    },
  );
  const reactivate = useSave(
    (api, input: { rowVersion: number }, key) =>
      api.post<SupplierDetail>(supplierPath(s.id, '/reactivate'), input, {
        idempotencyKey: key,
      }),
    { invalidate: [MD_KEYS.suppliers], onSuccess: () => toast(t('masterdata:reactivated')) },
  );
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

  const none = t('masterdata:none');
  const text = (value: string | null) => value ?? none;
  const stale = [deactivate.error, reactivate.error].some(isStale);

  return (
    <Card rise index={2} className={styles.sec}>
      <div className={styles.head}>
        <div className={styles.who}>
          <Tile>
            <Truck aria-hidden="true" />
          </Tile>
          <span>
            <h2 className={styles.name}>{s.name}</h2>
            <span className={styles.sub}>
              <bdi>{s.code}</bdi>
            </span>
          </span>
        </div>
        {!s.isActive && (
          <Chip icon={<Ban aria-hidden="true" />}>{t('masterdata:status.inactive')}</Chip>
        )}
      </div>
      {!s.isActive && (
        <div className={styles.offbar}>
          <Ban aria-hidden="true" />
          <span>{t('parties:suppliers.deactivatedBar')}</span>
        </div>
      )}
      {stale && <StaleNotice onReload={() => void reload()} busy={reloading} />}
      {reactivate.error !== null && !isStale(reactivate.error) && (
        <Alert>{errorText(reactivate.error)}</Alert>
      )}
      <DefinitionList
        rows={[
          {
            label: t('parties:detail.trn'),
            value: s.isVatRegistered && s.trn ? <bdi>{s.trn}</bdi> : t('parties:vat.notRegistered'),
          },
          ...(s.nameAlt ? [{ label: t('parties:detail.nameAlt'), value: s.nameAlt }] : []),
          { label: t('parties:detail.terms'), value: termsText(s.paymentTermsDays) },
          { label: t('parties:detail.phone'), value: <Phone value={s.phone} /> },
          { label: t('parties:detail.email'), value: s.email ? <bdi>{s.email}</bdi> : none },
          { label: t('parties:detail.address'), value: text(s.addressLine) },
          { label: t('parties:detail.city'), value: text(s.city) },
          {
            label: t('parties:detail.emirate'),
            value: s.emirate ? t(`masterdata:emirates.${s.emirate}`) : none,
          },
          { label: t('parties:detail.country'), value: <bdi>{s.countryCode}</bdi> },
        ]}
      />
      {s.notes && (
        <div className={styles.section}>
          <h3 className={styles.fieldLabel}>{t('parties:detail.notes')}</h3>
          <p className={styles.notes}>{s.notes}</p>
        </div>
      )}
      <div className={styles.acts}>
        {s.isActive && (
          <Button onPress={() => setDialog('edit')}>
            <Pencil className={iconClass.sm} aria-hidden="true" />
            {t('masterdata:actions.edit')}
          </Button>
        )}
        {s.isActive ? (
          <Button
            variant="dangerGhost"
            onPress={() => {
              deactivate.reset();
              setDialog('deactivate');
            }}
          >
            <Ban className={iconClass.sm} aria-hidden="true" />
            {t('parties:suppliers.deactivate')}
          </Button>
        ) : (
          <Button
            busy={reactivate.isPending}
            onPress={() => reactivate.mutate({ rowVersion: s.rowVersion })}
          >
            <Undo2 className={iconClass.sm} aria-hidden="true" />
            {t('masterdata:actions.reactivate')}
          </Button>
        )}
      </div>
      {dialog === 'edit' && (
        <SupplierDialog
          supplier={s}
          onReload={props.onReload}
          onClose={() => setDialog(null)}
          onSaved={() => setDialog(null)}
        />
      )}
      {dialog === 'deactivate' && (
        <DeactivateDialog
          title={t('parties:suppliers.deactivateTitle')}
          subject={<b>{s.name}</b>}
          explanation={t('parties:suppliers.deactivateExplain')}
          busy={deactivate.isPending}
          error={deactivate.error !== null && !isStale(deactivate.error) ? deactivate.error : null}
          onConfirm={(reason) =>
            deactivate.mutate(
              { reason, rowVersion: s.rowVersion },
              { onError: (error) => isStale(error) && setDialog(null) },
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
    </Card>
  );
}
