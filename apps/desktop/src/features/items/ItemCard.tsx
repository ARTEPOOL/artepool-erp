import { useState } from 'react';
import { Ban, Pencil, Star, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { ItemDetail } from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { useSave } from '../../api/hooks';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
  EmptyState,
  iconClass,
  Tile,
  useToast,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { DeactivateDialog } from '../masterdata/DeactivateDialog';
import { money, price, priceBoth, rate } from '../masterdata/format';
import {
  localName,
  MD_KEYS,
  useBusinessLines,
  useCategories,
  useUnits,
  useVat,
} from '../masterdata/refs';
import { itemPath, useItem } from './api';
import { quantityText } from './form';
import { marginOf, percentText } from './margin';
import { ItemIcon, PriceFigures, StatusChip, TypeLabel } from './parts';
import styles from './items.module.css';

/** The selected item (design 07 detail panel, without the stock parts that arrive in M3). */
export function ItemCard(props: { id: string; onEdit: (item: ItemDetail) => void }) {
  const { t, i18n } = useTranslation('items');
  const tm = useTranslation('masterdata').t;
  const can = useCan();
  const errorText = useErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const name = localName(i18n.language);
  const detail = useItem(props.id);
  const units = useUnits();
  const categories = useCategories();
  const vat = useVat();
  const lines = useBusinessLines();
  const [deactivating, setDeactivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deactivate = useSave(
    (api, input: { item: ItemDetail; reason: string }, key) =>
      api.post<ItemDetail>(
        itemPath(input.item.id, '/deactivate'),
        { reason: input.reason, rowVersion: input.item.rowVersion },
        { idempotencyKey: key },
      ),
    {
      invalidate: [MD_KEYS.items],
      onSuccess: () => {
        setDeactivating(false);
        toast(tm('deactivated'));
      },
    },
  );
  const reactivate = useSave(
    (api, item: ItemDetail, key) =>
      api.post<ItemDetail>(
        itemPath(item.id, '/reactivate'),
        { rowVersion: item.rowVersion },
        { idempotencyKey: key },
      ),
    { invalidate: [MD_KEYS.items], onSuccess: () => toast(tm('reactivated')) },
  );

  /** Someone else saved first: load their version so the next try starts from it. */
  const refreshIfStale = (caught: unknown) => {
    if (caught instanceof ApiError && caught.code === 'STALE_VERSION') {
      void queryClient.invalidateQueries({ queryKey: MD_KEYS.items });
    }
  };

  const item = detail.data;
  if (!item) {
    return (
      <Card rise index={7}>
        <EmptyState>{detail.isError ? errorText(detail.error) : t('list.loading')}</EmptyState>
      </Card>
    );
  }

  const unit = units.data?.find((u) => u.id === item.unitId);
  const category = categories.data?.find((c) => c.id === item.categoryId);
  const vatCategory = vat.data?.categories.find((c) => c.id === item.vatCategoryId);
  const line = lines.data?.find((l) => l.id === item.defaultBusinessLineId);
  const unitOf = (id: string) => units.data?.find((u) => u.id === id);
  const manage = can('items.manage');
  const description = i18n.language === 'en' ? item.descriptionEn : item.descriptionAr;

  const rows = [
    { label: t('fields.type'), value: <TypeLabel type={item.itemType} /> },
    { label: t('fields.category'), value: category ? name(category) : tm('none') },
    { label: t('fields.unit'), value: unit ? name(unit) : tm('none') },
    {
      label: t('fields.vatCategory'),
      value: vatCategory ? (
        <>
          {name(vatCategory)} · <bdi>{rate(vatCategory.rateBp)}</bdi>
        </>
      ) : (
        tm('none')
      ),
    },
    { label: t('fields.businessLine'), value: line ? name(line) : tm('none') },
    { label: t('fields.forSale'), value: item.isSellable ? tm('yes') : tm('no') },
  ];
  if (item.price) {
    rows.push(
      {
        label: t('fields.price'),
        value: (
          <>
            <bdi>{price(BigInt(item.price.price4dp))}</bdi> {t('aed')}
          </>
        ),
      },
      { label: t('fields.includesVat'), value: item.price.includesVat ? tm('yes') : tm('no') },
    );
  }
  // Purchase price and profit per unit: only the owner is sent them (decision 0038).
  if (item.purchaseCost4dp !== undefined) {
    const cost = item.purchaseCost4dp === null ? null : BigInt(item.purchaseCost4dp);
    rows.push({
      label: item.itemType === 'bundle' ? t('fields.kitCost') : t('fields.purchaseCost'),
      value:
        cost === null ? (
          item.itemType === 'bundle' ? (
            t('detail.kitCostUnknown')
          ) : (
            tm('none')
          )
        ) : (
          <>
            <bdi>{price(cost)}</bdi> {t('aed')}
          </>
        ),
    });
    if (cost !== null && item.price && vatCategory) {
      const net = priceBoth(
        BigInt(item.price.price4dp),
        item.price.includesVat,
        vatCategory.rateBp,
      ).netFils;
      const margin = marginOf(net, cost);
      rows.push({
        label: t('price.profit'),
        value: (
          <>
            <bdi>{money(margin.profitFils)}</bdi> {t('aed')}
            {margin.tenthsOfPercent !== null && (
              <>
                {' '}
                · <bdi>{percentText(margin.tenthsOfPercent)}</bdi>
              </>
            )}
          </>
        ),
      });
    }
  }
  if (item.itemType === 'stock') {
    rows.push({
      label: t('fields.reorderLevel'),
      value:
        item.reorderLevelMilli === null ? (
          tm('none')
        ) : (
          <>
            <bdi>{quantityText(item.reorderLevelMilli)}</bdi> {unit ? name(unit) : ''}
          </>
        ),
    });
  }

  return (
    <>
      <Card rise index={7}>
        <div className={styles.cardHead}>
          <div className={styles.headName}>
            <Tile>
              <ItemIcon type={item.itemType} />
            </Tile>
            <div>
              <h2>{name(item)}</h2>
              <span className={styles.muted}>
                <bdi>{item.code}</bdi>
                {item.primaryBarcode && (
                  <>
                    {' · '}
                    <bdi>{item.primaryBarcode}</bdi>
                  </>
                )}
              </span>
            </div>
          </div>
          <StatusChip active={item.isActive} />
        </div>
        <div className={styles.cardBody}>
          {!item.isActive && (
            <div className={styles.offbar}>
              <Ban aria-hidden="true" />
              <span>{t('detail.inactive')}</span>
            </div>
          )}
          {error && <Alert>{error}</Alert>}
          {description && <p className={styles.muted}>{description}</p>}
          {item.price && vatCategory ? (
            <section aria-label={t('price.oneUnit')} className={styles.section}>
              <h3>{t('price.oneUnit')}</h3>
              <PriceFigures
                price4dp={BigInt(item.price.price4dp)}
                includesVat={item.price.includesVat}
                rateBp={vatCategory.rateBp}
              />
            </section>
          ) : (
            !item.price && <p className={styles.muted}>{t('list.noPrice')}</p>
          )}
          <DefinitionList rows={rows} />
          {manage && (
            <div className={styles.actions}>
              <Button onPress={() => props.onEdit(item)}>
                <Pencil className={iconClass.sm} aria-hidden="true" />
                {tm('actions.edit')}
              </Button>
              {item.isActive ? (
                <Button
                  variant="dangerGhost"
                  onPress={() => {
                    setError(null);
                    deactivate.reset();
                    setDeactivating(true);
                  }}
                >
                  <Ban className={iconClass.sm} aria-hidden="true" />
                  {tm('actions.deactivate')}
                </Button>
              ) : (
                <Button
                  busy={reactivate.isPending}
                  onPress={() => {
                    setError(null);
                    reactivate.mutate(item, {
                      onError: (caught) => {
                        refreshIfStale(caught);
                        setError(errorText(caught));
                      },
                    });
                  }}
                >
                  <Undo2 className={iconClass.sm} aria-hidden="true" />
                  {tm('actions.reactivate')}
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card rise index={8}>
        <section aria-label={t('fields.barcodes')} className={styles.section}>
          <h3>{t('fields.barcodes')}</h3>
          {item.barcodes.length === 0 ? (
            <p className={styles.muted}>{t('detail.noBarcodes')}</p>
          ) : (
            <ul className={styles.plainList}>
              {item.barcodes.map((b) => (
                <li key={b.id}>
                  <span>
                    <bdi>{b.barcode}</bdi>
                    {b.isPrimary && (
                      <span className={styles.badge}>
                        <Star aria-hidden="true" />
                        {t('barcodes.primary')}
                      </span>
                    )}
                  </span>
                  {b.qtyPerScanMilli !== '1000' && (
                    <span className={styles.muted}>
                      {t('barcodes.perScanShort')} <bdi>{quantityText(b.qtyPerScanMilli)}</bdi>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        {item.itemType === 'bundle' && (
          <section aria-label={t('fields.components')} className={styles.section}>
            <h3>{t('fields.components')}</h3>
            <ul className={styles.plainList}>
              {item.components.map((c) => {
                const cu = unitOf(c.unitId);
                return (
                  <li key={c.itemId}>
                    <span>
                      {name(c)}
                      <span className={styles.muted}>
                        {' · '}
                        <bdi>{c.code}</bdi>
                      </span>
                    </span>
                    <span>
                      <bdi>{quantityText(c.quantityMilli)}</bdi> {cu ? name(cu) : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </Card>

      {deactivating && (
        <DeactivateDialog
          title={t('deactivate.title')}
          subject={
            <>
              <b>{name(item)}</b> · <bdi>{item.code}</bdi>
            </>
          }
          explanation={t('deactivate.explanation')}
          busy={deactivate.isPending}
          error={deactivate.error}
          onConfirm={(reason) => deactivate.mutate({ item, reason }, { onError: refreshIfStale })}
          onClose={() => setDeactivating(false)}
        />
      )}
    </>
  );
}
