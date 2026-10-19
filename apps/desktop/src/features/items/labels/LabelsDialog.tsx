import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ItemDetail, LabelSizeItem } from '@artepool/shared/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  iconClass,
  SelectField,
  Switch,
  TextField,
} from '../../../ui';
import { money, priceBoth } from '../../masterdata/format';
import { localName, useLabelSizes } from '../../masterdata/refs';
import mdStyles from '../../masterdata/masterdata.module.css';
import { canEncode, code128Bars } from './code128';
import styles from './labels.module.css';

const MAX_LABELS = 500;
/** Quiet zone on each side of the bars, in modules (Code 128 asks for at least 10). */
const QUIET = 10;

/** The Code 128 bars as an SVG, stretched to the label's width. */
export function BarcodeSvg({ text, label }: { text: string; label: string }) {
  const { bars, modules } = code128Bars(text);
  const width = modules + QUIET * 2;
  return (
    <svg
      className={styles.bars}
      viewBox={`0 0 ${width} 40`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      data-modules={modules}
    >
      {bars.map((bar) => (
        <rect key={bar.x} x={bar.x + QUIET} y={0} width={bar.w} height={40} fill="currentColor" />
      ))}
    </svg>
  );
}

interface LabelContent {
  name: string;
  data: string;
  priceText: string | null;
}

/** The label size as CSS custom properties, read by the module CSS. */
const sizeVars = (size: LabelSizeItem) =>
  ({ '--label-w': `${size.widthMm}mm`, '--label-h': `${size.heightMm}mm` }) as CSSProperties;

/** One label at its real size in millimetres (custom properties read by the module CSS). */
function Label(props: { size: LabelSizeItem; content: LabelContent; barcodeLabel: string }) {
  const { size, content } = props;
  // The barcode is always printed; the name and price only when the label has room (0043).
  const roomForName = size.heightMm >= 25;
  const roomForPrice = size.heightMm >= 20;
  return (
    <div className={styles.label} style={sizeVars(size)}>
      {roomForName && <span className={styles.name}>{content.name}</span>}
      <BarcodeSvg text={content.data} label={props.barcodeLabel} />
      <bdi className={styles.code}>{content.data}</bdi>
      {roomForPrice && content.priceText && <bdi className={styles.price}>{content.priceText}</bdi>}
    </div>
  );
}

/** The page size for printing: one label per page on a roll, or A4 sheets filled with labels. */
function pageRule(size: LabelSizeItem, sheet: boolean): string {
  return sheet
    ? '@page { size: A4; margin: 10mm; }'
    : `@page { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0; }`;
}

/**
 * Design 07 "Barcode labels" (decision 0043): how many, which size, A4 sheets or a label roll,
 * and the price with VAT if wanted. Printing goes through the normal print dialog for now.
 */
export function LabelsDialog(props: {
  item: ItemDetail;
  /** The item's VAT rate (basis points), for the price with VAT. */
  rateBp: number | undefined;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('items');
  const name = localName(i18n.language);
  const sizes = useLabelSizes();
  const active = (sizes.data ?? [])
    .filter((s) => s.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const [count, setCount] = useState('1');
  const [sizeId, setSizeId] = useState('');
  const [sheet, setSheet] = useState(false);
  const [showPrice, setShowPrice] = useState(props.item.price !== null);
  const [countError, setCountError] = useState(false);
  const [printing, setPrinting] = useState(0);

  const size = active.find((s) => s.id === sizeId) ?? active[0];
  const data = props.item.primaryBarcode ?? props.item.code;
  const encodable = canEncode(data);
  const gross =
    props.item.price && props.rateBp !== undefined
      ? priceBoth(BigInt(props.item.price.price4dp), props.item.price.includesVat, props.rateBp)
          .grossFils
      : null;
  const content: LabelContent = {
    name: name(props.item),
    data,
    priceText: showPrice && gross !== null ? `${money(gross)} ${t('aed')}` : null,
  };
  const barcodeLabel = t('labels.barcodeOf', { code: data });
  const n = /^\d{1,3}$/.test(count.trim()) ? Number(count.trim()) : 0;

  // Printing: the labels are placed in a print-only container, the page size is set for this
  // print only, and the normal print dialog opens. Both stay until the printing has really
  // finished ("afterprint"): in some windows the dialog does not hold the screen code, and
  // removing them at once would print empty pages.
  useEffect(() => {
    if (!printing || !size) return;
    const style = document.createElement('style');
    style.textContent = pageRule(size, sheet);
    document.head.appendChild(style);
    const done = () => setPrinting(0);
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    return () => {
      window.removeEventListener('afterprint', done);
      style.remove();
    };
  }, [printing, size, sheet]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (n < 1 || n > MAX_LABELS) return setCountError(true);
    setCountError(false);
    if (!size || !encodable) return;
    setPrinting(n);
  };

  return (
    <Dialog isOpen onClose={props.onClose} title={t('labels.title')}>
      <form onSubmit={submit} noValidate className={mdStyles.form}>
        <div>
          <b>{name(props.item)}</b>
          <span className={styles.muted}>
            {' · '}
            <bdi>{props.item.code}</bdi>
          </span>
        </div>
        <div className={mdStyles.grid2}>
          <TextField
            label={t('labels.count')}
            value={count}
            onChange={setCount}
            inputMode="numeric"
            autoComplete="off"
            ltr
            isRequired
            error={countError ? t('labels.errors.count', { max: MAX_LABELS }) : undefined}
          />
          <SelectField
            id="labels-size"
            label={t('labels.size')}
            value={size?.id ?? ''}
            onChange={setSizeId}
            options={active.map((s) => ({
              value: s.id,
              label: `${name(s)} (${s.widthMm} × ${s.heightMm})`,
            }))}
          />
        </div>
        <Switch isSelected={sheet} onChange={setSheet}>
          {t('labels.sheet')}
        </Switch>
        <Switch
          isSelected={showPrice && gross !== null}
          onChange={setShowPrice}
          isDisabled={gross === null}
        >
          {t('labels.showPrice')}
        </Switch>
        {sizes.isSuccess && active.length === 0 && <Alert>{t('labels.noSizes')}</Alert>}
        {!encodable && <Alert>{t('labels.cannotEncode')}</Alert>}
        {size && encodable && (
          <div className={styles.previewBox}>
            <span className={styles.muted}>{t('labels.preview')}</span>
            <div data-testid="label-preview" className={styles.preview}>
              <Label size={size} content={content} barcodeLabel={barcodeLabel} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('adjust.cancel')}</Button>
          <Button type="submit" variant="primary" isDisabled={!size || !encodable}>
            <Printer className={iconClass.sm} aria-hidden="true" />
            {t('labels.print')}
          </Button>
        </DialogFooter>
      </form>
      {printing > 0 &&
        size &&
        createPortal(
          <div
            className={sheet ? styles.printSheet : styles.printRoll}
            style={sizeVars(size)}
            data-testid="label-print"
          >
            {Array.from({ length: printing }, (_, i) => (
              <Label key={i} size={size} content={content} barcodeLabel={barcodeLabel} />
            ))}
          </div>,
          document.body,
        )}
    </Dialog>
  );
}
