/**
 * One cart line: quantity, a discount in percent, or a different unit price (decision 0059). A
 * discount above the cashier's limit and any changed price are approved by a supervisor when
 * paying; the server checks both again.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Dialog, DialogFooter, Note, TextField } from '../../ui';
import { price } from '../masterdata/format';
import { localName } from '../masterdata/refs';
import { useLineRefs } from '../sales/LineEditor';
import { readLine, type EditorLine } from '../sales/lines';
import { cartStore, setQuantity, updateLine } from './cart';
import styles from './pos.module.css';

export function LineDialog(props: { line: EditorLine; onClose: () => void }) {
  const { t, i18n } = useTranslation('pos');
  const refs = useLineRefs();
  const [quantity, setQty] = useState(props.line.quantity);
  const [discount, setDiscount] = useState(props.line.discount);
  const [unitPrice, setUnitPrice] = useState(props.line.unitPrice);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: EditorLine = {
      ...props.line,
      quantity,
      discount,
      discountMode: 'percent',
      unitPrice,
    };
    const read = readLine(next, refs.unitDecimalsOf(next.unitId));
    if (!read.ok) return setProblem(t(`lineProblem.${read.problem}`));
    cartStore.set((c) =>
      updateLine(setQuantity(c, props.line.key, quantity), props.line.key, {
        discount,
        discountMode: 'percent',
        unitPrice,
      }),
    );
    props.onClose();
  };

  return (
    <Dialog isOpen onClose={props.onClose} title={localName(i18n.language)(props.line)}>
      <form onSubmit={submit} noValidate className={styles.payForm}>
        <TextField
          label={t('line.quantity')}
          value={quantity}
          onChange={setQty}
          inputMode="decimal"
          ltr
          autoFocus
        />
        <TextField
          label={t('line.discountPercent')}
          value={discount}
          onChange={setDiscount}
          inputMode="decimal"
          ltr
          hint={t('discountLimitNote')}
        />
        <TextField
          label={t('line.unitPrice')}
          value={unitPrice}
          onChange={setUnitPrice}
          inputMode="decimal"
          ltr
          placeholder={price(BigInt(props.line.listPrice4dp))}
          hint={t('line.priceNeedsSupervisor')}
        />
        <Note>{t('line.listPrice', { price: price(BigInt(props.line.listPrice4dp)) })}</Note>
        {problem && <Alert>{problem}</Alert>}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('cancel')}</Button>
          <Button type="submit" variant="primary">
            {t('apply')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
