/**
 * The record of label prints (decision 0099): after labels are sent, the screen tells the server
 * what it printed, with the price on each label. Items whose price changed while printing are not
 * recorded; the server names them so the screen can say so. Also the default number of labels.
 */
import type {
  LabelItem,
  RecordLabelPrintsRequest,
  RecordLabelPrintsResponse,
} from '@artepool/shared/contracts';
import { useSave } from '../../../api/hooks';

export const PRICE_CHANGED_KEY = ['label-prints', 'price-changed'] as const;

/** Above this many labels the screen asks before printing. */
export const CONFIRM_ABOVE = 100;

export function useRecordLabelPrints() {
  return useSave(
    (client, body: RecordLabelPrintsRequest, key) =>
      client.post<RecordLabelPrintsResponse>('/api/v1/label-prints', body, {
        idempotencyKey: key,
      }),
    { invalidate: [PRICE_CHANGED_KEY] },
  );
}

/** The price as it is printed on the label, for the record (null: no price on the label). */
export function printedPrice(
  price: { price4dp: string; includesVat: boolean } | null,
  rateBp: number | undefined,
  withPrice: boolean,
): RecordLabelPrintsRequest['lines'][number]['price'] {
  return withPrice && price && rateBp !== undefined ? { ...price, rateBp } : null;
}

/**
 * The number of labels an item gets by default: items counted in units get one per unit (the
 * quantity received, or on hand; never below 0); items sold by weight or length get one.
 */
export function defaultCopies(
  item: Pick<LabelItem, 'unitDecimals' | 'onHandMilli'>,
  quantityMilli: string | null,
): number {
  if (item.unitDecimals > 0) return 1;
  if (quantityMilli === null) return 1;
  const whole = BigInt(quantityMilli) / 1000n;
  return whole > 0n ? Number(whole) : 0;
}
