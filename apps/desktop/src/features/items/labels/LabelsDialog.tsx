import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_LABEL_PRINTER,
  type ItemDetail,
  type LabelPrinterConfig,
  type LabelSizeItem,
} from '@artepool/shared/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogFooter,
  iconClass,
  Note,
  SelectField,
  Switch,
  TextField,
  useToast,
} from '../../../ui';
import { money, priceBoth } from '../../masterdata/format';
import { localName, useLabelSizes } from '../../masterdata/refs';
import mdStyles from '../../masterdata/masterdata.module.css';
import { barcodeFor } from './barcode';
import { layoutBoxes, layoutLabel, type LayoutResult } from './layout';
import { canPrintLabelsSilently, printLabels, useLabelPrinter } from './printer';
import { canvasMeasurer, renderLabel, type LabelImage } from './render';
import styles from './labels.module.css';

const MAX_LABELS = 500;
/** A4 label sheets print through the print dialog on an office printer: drawn finely. */
const SHEET_DPI = 300;

/** The label size as CSS custom properties, read by the module CSS (a real-size image). */
const sizeVars = (size: Pick<LabelSizeItem, 'widthMm' | 'heightMm'>) =>
  ({ '--label-w': `${size.widthMm}mm`, '--label-h': `${size.heightMm}mm` }) as CSSProperties;

/** The page size for the print dialog: one label per page on a roll, or A4 sheets of labels. */
function pageRule(size: LabelSizeItem, sheet: boolean): string {
  return sheet
    ? '@page { size: A4; margin: 10mm; }'
    : `@page { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0; }`;
}

/**
 * Design 07 "Barcode labels" (decisions 0043, 0096): how many, which size, the price and the English
 * name if wanted. The label is drawn at the label printer's own dots (the preview is that image at
 * real size) and printed silently on this PC's label printer; without one (or for A4 label sheets)
 * the print dialog opens instead.
 */
export function LabelsDialog(props: {
  item: ItemDetail;
  /** The item's VAT rate (basis points), for the price with VAT. */
  rateBp: number | undefined;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('items');
  const toast = useToast();
  const name = localName(i18n.language);
  const language = i18n.language === 'en' ? 'en' : 'ar';
  const sizes = useLabelSizes();
  const printer: LabelPrinterConfig = useLabelPrinter().data ?? DEFAULT_LABEL_PRINTER;
  const active = (sizes.data ?? [])
    .filter((s) => s.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const [count, setCount] = useState('1');
  const [sizeId, setSizeId] = useState('');
  const [sheet, setSheet] = useState(false);
  const [showPrice, setShowPrice] = useState(props.item.price !== null);
  const [addEnglish, setAddEnglish] = useState(false);
  const [countError, setCountError] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogCopies, setDialogCopies] = useState(0);

  const size = active.find((s) => s.id === sizeId) ?? active[0];
  const data = props.item.primaryBarcode ?? props.item.code;
  const barcode = useMemo(() => barcodeFor(data), [data]);
  const gross =
    props.item.price && props.rateBp !== undefined
      ? priceBoth(BigInt(props.item.price.price4dp), props.item.price.includesVat, props.rateBp)
          .grossFils
      : null;
  const priced = showPrice && gross !== null;
  const silent = !sheet && canPrintLabelsSilently(printer);
  const n = /^\d{1,3}$/.test(count.trim()) ? Number(count.trim()) : 0;

  // The label, laid out and drawn at the printer's dots (A4 sheets: finely, for an office printer).
  const measurer = useMemo(() => canvasMeasurer(), []);
  const drawn = useMemo((): { layout: LayoutResult; image: LabelImage | null } | null => {
    if (!size || !barcode) return null;
    const geometry = sheet
      ? {
          widthMm: size.widthMm,
          heightMm: size.heightMm,
          dpi: SHEET_DPI,
          printableWidthMm: size.widthMm,
        }
      : {
          widthMm: size.widthMm,
          heightMm: size.heightMm,
          dpi: printer.dpi,
          printableWidthMm: printer.printableWidthMm,
        };
    const layout = layoutLabel(
      geometry,
      {
        nameAr: props.item.nameAr,
        nameEn: addEnglish ? props.item.nameEn : null,
        barcode,
        // The label follows the screen's language: "120.00 درهم" or "AED 120.00".
        price:
          priced && gross !== null
            ? {
                language,
                amount: money(gross),
                currency: t('aed'),
                vatNote: props.item.price?.includesVat ? t('labels.inclVat') : null,
              }
            : null,
      },
      measurer,
    );
    if (!layout.ok) return { layout, image: null };
    const dots = (mm: number) => Math.round((mm * geometry.dpi) / 25.4);
    // The printer's calibration moves the drawing on a roll; a sheet is placed by the office printer.
    const offset = sheet
      ? { x: 0, y: 0 }
      : { x: dots(printer.offsetXMm), y: dots(printer.offsetYMm) };
    try {
      return { layout, image: renderLabel(layout, offset) };
    } catch {
      // No canvas to draw on (only in some test browsers): laid out, not drawn.
      return { layout, image: null };
    }
  }, [size, barcode, sheet, printer, props.item, addEnglish, priced, gross, language, measurer, t]);
  const layout = drawn?.layout;
  const imageUrl = useMemo(() => drawn?.image?.canvas.toDataURL('image/png') ?? '', [drawn]);
  const refused = layout && !layout.ok ? layout.reason : null;

  // The print dialog (no label printer here, or A4 sheets): the drawn labels go into a print-only
  // container and the page size is set for this print only. Both stay until the printing has
  // really finished ("afterprint"): some print dialogs do not hold the screen.
  useEffect(() => {
    if (!dialogCopies || !size) return;
    const style = document.createElement('style');
    style.textContent = pageRule(size, sheet);
    document.head.appendChild(style);
    const done = () => setDialogCopies(0);
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    return () => {
      window.removeEventListener('afterprint', done);
      style.remove();
    };
  }, [dialogCopies, size, sheet]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (n < 1 || n > MAX_LABELS) return setCountError(true);
    setCountError(false);
    if (!size || !layout?.ok) return;
    if (!silent) return setDialogCopies(n);
    if (!drawn?.image) return;
    setBusy(true);
    const outcome = await printLabels(drawn.image, size, printer, n, `labels-${props.item.code}`);
    setBusy(false);
    if (outcome.printed) {
      setProblem(null);
      toast(t('labels.sent', { count: n }));
    } else {
      setProblem(t(`labels.problem.${outcome.reason}`));
    }
  };

  return (
    <Dialog isOpen onClose={props.onClose} title={t('labels.title')}>
      <form onSubmit={(event) => void submit(event)} noValidate className={mdStyles.form}>
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
        <Switch isSelected={priced} onChange={setShowPrice} isDisabled={gross === null}>
          {t('labels.showPrice')}
        </Switch>
        <Switch
          isSelected={addEnglish}
          onChange={setAddEnglish}
          isDisabled={!props.item.nameEn?.trim()}
        >
          {t('labels.addEnglish')}
        </Switch>
        <Switch isSelected={sheet} onChange={setSheet}>
          {t('labels.sheet')}
        </Switch>
        {sizes.isSuccess && active.length === 0 && <Alert>{t('labels.noSizes')}</Alert>}
        {!barcode && <Alert>{t('labels.cannotEncode')}</Alert>}
        {refused && <Alert>{t(`labels.refused.${refused}`)}</Alert>}
        {layout?.ok && size && (
          <div className={styles.previewBox}>
            <span className={styles.muted}>{t('labels.preview')}</span>
            <div
              data-testid="label-preview"
              className={styles.preview}
              data-layout={JSON.stringify({
                widthDots: layout.widthDots,
                content: layout.content,
                boxes: layoutBoxes(layout),
                name: layout.name.map((line) => line.text),
                english: layout.english?.text ?? null,
                price: layout.price?.runs ?? null,
                vat: layout.vat?.text ?? null,
                moduleDots: layout.bars.moduleDots,
              })}
            >
              <img
                className={styles.label}
                style={sizeVars(size)}
                src={imageUrl || undefined}
                alt={t('labels.barcodeOf', { code: data })}
              />
            </div>
          </div>
        )}
        {!silent && size && layout?.ok && (
          <Note>{t(sheet ? 'labels.sheetNote' : 'labels.dialogNote')}</Note>
        )}
        {problem && <Alert>{problem}</Alert>}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('adjust.cancel')}</Button>
          <Button type="submit" variant="primary" busy={busy} isDisabled={!size || !layout?.ok}>
            <Printer className={iconClass.sm} aria-hidden="true" />
            {t('labels.print')}
          </Button>
        </DialogFooter>
      </form>
      {dialogCopies > 0 &&
        size &&
        createPortal(
          <div
            className={sheet ? styles.printSheet : styles.printRoll}
            style={sizeVars(size)}
            data-testid="label-print"
          >
            {Array.from({ length: dialogCopies }, (_, i) => (
              <img key={i} className={styles.label} src={imageUrl || undefined} alt="" />
            ))}
          </div>,
          document.body,
        )}
    </Dialog>
  );
}
