import { useState } from 'react';
import { Barcode, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ItemDetail } from '@artepool/shared/contracts';
import { Alert, Button, Card, cx, DefinitionList, iconClass } from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { money, price } from '../masterdata/format';
import { localName, useReasonCodes, useUnits } from '../masterdata/refs';
import { useItemStock } from './api';
import { quantityText } from './form';
import { canAdjustAny, signedQuantity, totals } from './stock';
import styles from './items.module.css';

const LATEST = 10;
const ALL_PAGE = 50;

/**
 * The stock part of the item card (design 07), for stock items and `stock.view`: sellable and
 * defective quantities (values and average cost with `stock.view_cost` only — the server leaves
 * them out otherwise), the reorder level, and the movements the stock is calculated from.
 */
export function StockCard(props: {
  item: ItemDetail;
  onAdjust: (figures: { onHandMilli: string; defectiveMilli: string }) => void;
  onLabels: () => void;
}) {
  const { t, i18n } = useTranslation('items');
  const tm = useTranslation('masterdata').t;
  const can = useCan();
  const errorText = useErrorText();
  const name = localName(i18n.language);
  const units = useUnits();
  const reasonCodes = useReasonCodes();
  const [showAll, setShowAll] = useState(false);
  const stock = useItemStock(props.item.id, showAll ? ALL_PAGE : LATEST, true);

  const unit = units.data?.find((u) => u.id === props.item.unitId);
  const unitName = unit ? name(unit) : '';
  const pages = stock.data?.pages ?? [];
  const first = pages[0];
  const movements = pages.flatMap((p) => p.movements);
  const total = first?.totalMovements ?? 0;
  const sums = totals(first?.balances ?? []);
  const reasonOf = (id: string | null) => reasonCodes.data?.find((r) => r.id === id);
  const qty = (milli: bigint | string) => (
    <>
      <bdi>{quantityText(milli.toString())}</bdi> {unitName}
    </>
  );

  const rows = [
    {
      label: t('fields.reorderLevel'),
      value: props.item.reorderLevelMilli === null ? tm('none') : qty(props.item.reorderLevelMilli),
    },
  ];
  if (can('stock.view_cost')) {
    rows.unshift(
      {
        label: t('stock.avgCost'),
        value:
          sums.avgUnitCost4dp === null ? (
            tm('none')
          ) : (
            <>
              <bdi>{price(BigInt(sums.avgUnitCost4dp))}</bdi> {t('aed')}
            </>
          ),
      },
      {
        label: t('stock.value'),
        value: (
          <>
            <bdi>{money(sums.onHandValueFils ?? 0n)}</bdi> {t('aed')}
          </>
        ),
      },
      {
        label: t('stock.defectiveValue'),
        value: (
          <>
            <bdi>{money(sums.defectiveValueFils ?? 0n)}</bdi> {t('aed')}
          </>
        ),
      },
    );
  }

  return (
    <Card rise index={8}>
      <section aria-label={t('stock.title')} className={styles.section}>
        <h3>{t('stock.title')}</h3>
        {stock.isError && <Alert>{errorText(stock.error)}</Alert>}
        <div className={styles.pair} data-testid="stock-pair">
          <div className={cx(sums.onHandMilli > 0n && styles.ok)}>
            <span>{t('stock.sellable')}</span>
            <b>
              <bdi>{first ? quantityText(sums.onHandMilli.toString()) : '—'}</bdi>
            </b>
            <span>{unitName}</span>
          </div>
          <div>
            <span>{t('stock.defective')}</span>
            <b>
              <bdi>{first ? quantityText(sums.defectiveMilli.toString()) : '—'}</bdi>
            </b>
            <span>{unitName}</span>
          </div>
        </div>
        <DefinitionList rows={rows} />
        {(canAdjustAny(can) || can('labels.print')) && (
          <div className={styles.actions}>
            {canAdjustAny(can) && props.item.isActive && (
              <Button
                isDisabled={!first}
                onPress={() =>
                  props.onAdjust({
                    onHandMilli: sums.onHandMilli.toString(),
                    defectiveMilli: sums.defectiveMilli.toString(),
                  })
                }
              >
                <RefreshCw className={iconClass.sm} aria-hidden="true" />
                {t('stock.adjust')}
              </Button>
            )}
            {can('labels.print') && (
              <Button onPress={props.onLabels}>
                <Barcode className={iconClass.sm} aria-hidden="true" />
                {t('labels.button')}
              </Button>
            )}
          </div>
        )}
      </section>

      <section aria-label={t('stock.movements')} className={styles.section}>
        <h3>{t('stock.movements')}</h3>
        {first && movements.length === 0 && (
          <p className={styles.muted}>{t('stock.noMovements')}</p>
        )}
        {movements.length > 0 && (
          <ul className={styles.movements} aria-label={t('stock.movements')}>
            {movements.map((m) => {
              const q = BigInt(m.quantityMilli);
              const reason = reasonOf(m.reasonCodeId);
              return (
                <li key={m.id}>
                  <span>
                    <span>
                      {t(`movement.${m.movementType}`)}
                      {m.documentNumber && (
                        <>
                          {' · '}
                          <bdi>{m.documentNumber}</bdi>
                        </>
                      )}
                    </span>
                    <span className={styles.muted}>
                      <bdi>{m.movementDate}</bdi>
                      {m.stockStatus === 'defective' && <> · {t('stock.defective')}</>}
                      {reason && <> · {name(reason)}</>}
                    </span>
                  </span>
                  <span className={styles.moveQty}>
                    <b className={q < 0n ? styles.out : styles.in}>
                      <bdi>{signedQuantity(q)}</bdi>
                    </b>
                    <span className={styles.muted}>
                      {t('stock.after')} <bdi>{quantityText(m.qtyAfterMilli)}</bdi>
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className={styles.more}>
          <span className={styles.muted}>{t('stock.calculated')}</span>
          {!showAll && total > movements.length && (
            <Button variant="ghost" onPress={() => setShowAll(true)}>
              {t('stock.showAll', { total })}
            </Button>
          )}
          {showAll && stock.hasNextPage && (
            <Button
              variant="ghost"
              busy={stock.isFetchingNextPage}
              onPress={() => void stock.fetchNextPage()}
            >
              {t('list.more')}
            </Button>
          )}
        </div>
      </section>
    </Card>
  );
}
