/** Small pieces shared by the items list, the detail panel and the item dialog. */
import { Ban, CheckCircle2, Layers, Package, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ItemType } from '@artepool/shared/contracts';
import { Chip } from '../../ui';
import { money, priceBoth } from '../masterdata/format';
import styles from './items.module.css';

export function TypeLabel({ type }: { type: ItemType }) {
  const { t } = useTranslation('items');
  return <>{t(`types.${type}`)}</>;
}

/** Stock item → a box, service → a wrench, kit → layers. */
export function ItemIcon({ type }: { type: ItemType }) {
  if (type === 'service') return <Wrench aria-hidden="true" />;
  if (type === 'bundle') return <Layers aria-hidden="true" />;
  return <Package aria-hidden="true" />;
}

/** Status = text + icon + colour (design rule). */
export function StatusChip({ active }: { active: boolean }) {
  const { t } = useTranslation('masterdata');
  return active ? (
    <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
      {t('status.active')}
    </Chip>
  ) : (
    <Chip icon={<Ban aria-hidden="true" />}>{t('status.inactive')}</Chip>
  );
}

/**
 * One unit as a tax invoice shows it: net, VAT and total (decision 0032). An inclusive price is
 * split back into net and VAT; an exclusive one gets VAT added, through the shared rounding helper.
 */
export function PriceFigures(props: { price4dp: bigint; includesVat: boolean; rateBp: number }) {
  const { t } = useTranslation('items');
  const both = priceBoth(props.price4dp, props.includesVat, props.rateBp);
  return (
    <div className={styles.figures} data-testid="price-figures">
      <div>
        <span>{t('price.net')}</span>
        <b>
          <bdi>{money(both.netFils)}</bdi>
        </b>
      </div>
      <div>
        <span>{t('price.vat')}</span>
        <b>
          <bdi>{money(both.vatFils)}</bdi>
        </b>
      </div>
      <div className={styles.total}>
        <span>{t('price.total')}</span>
        <b>
          <bdi>{money(both.grossFils)}</bdi>
        </b>
      </div>
    </div>
  );
}
