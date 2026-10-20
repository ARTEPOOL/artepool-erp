import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_LABEL_PRINTER,
  defaultLabelDesign,
  designForSize,
  type ItemDetail,
  type LabelPrinterConfig,
  type LabelSizeItem,
} from '@artepool/shared/contracts';
import { dubaiDay } from '../../../lib/format';
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
import { localName, useLabelSizes, useUnits } from '../../masterdata/refs';
import mdStyles from '../../masterdata/masterdata.module.css';
import { DateField } from '../../invoices/parts';
import { drawLabel, labelContent, useLabelDesign } from './design';
import { layoutBoxes } from './layout';
import { canPrintLabelsSilently, printLabels, useLabelPrinter } from './printer';
import { printedPrice, useRecordLabelPrints } from './record';
import { canvasMeasurer, printedDotsUrl } from './render';
import { labelWords } from './words';
import styles from './labels.module.css';

const MAX_LABELS = 500;

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
 * Design 07 "Barcode labels" (decisions 0043, 0096, 0097): how many, which size, the price, the
 * English name if wanted, and the expiry date and batch number when the owner's design shows them.
 * The label follows the owner's design and is drawn at the label printer's own dots (the preview is
 * that image); it prints silently on this PC's label printer, or through the print dialog without
 * one (and for A4 label sheets).
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
  const sizes = useLabelSizes();
  const units = useUnits();
  const designQuery = useLabelDesign();
  const printer: LabelPrinterConfig = useLabelPrinter().data ?? DEFAULT_LABEL_PRINTER;
  const active = (sizes.data ?? [])
    .filter((s) => s.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const [count, setCount] = useState('1');
  const [sizeId, setSizeId] = useState('');
  const [sheet, setSheet] = useState(false);
  const [showPrice, setShowPrice] = useState(props.item.price !== null);
  const [addEnglish, setAddEnglish] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [batch, setBatch] = useState('');
  const [countError, setCountError] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogCopies, setDialogCopies] = useState(0);
  const recordPrints = useRecordLabelPrints();
  // After the print dialog: how many labels were sent, until the person says whether they printed
  // (the dialog says "done" even when it was cancelled).
  const [askPrinted, setAskPrinted] = useState(0);

  const size = active.find((s) => s.id === sizeId) ?? active[0];
  const design = designQuery.data?.design ?? defaultLabelDesign();
  const forSize = size ? designForSize(design, size.code) : design;
  const silent = !sheet && canPrintLabelsSilently(printer);
  const n = /^\d{1,3}$/.test(count.trim()) ? Number(count.trim()) : 0;
  const canPrice = props.item.price !== null && props.rateBp !== undefined;

  // The label, laid out and drawn at the printer's dots (A4 sheets: finely, for an office printer).
  const measurer = useMemo(() => canvasMeasurer(), []);
  const words = useMemo(() => labelWords(i18n), [i18n]);
  const drawn = useMemo(() => {
    if (!size || !designQuery.data) return null;
    // "Add English name" shows it on this print, whatever the design says.
    const printDesign = addEnglish
      ? {
          ...design,
          elements: { ...design.elements, nameEn: { ...design.elements.nameEn, show: true } },
          overrides: Object.fromEntries(
            Object.entries(design.overrides).map(([code, o]) => [
              code,
              { ...o, elements: { ...o.elements, nameEn: { ...o.elements.nameEn, show: true } } },
            ]),
          ),
        }
      : design;
    const content = labelContent(props.item, {
      design: printDesign,
      shopName: designQuery.data.shopName,
      units: units.data ?? [],
      rateBp: props.rateBp,
      withPrice: showPrice,
      extras: { expiry, batch },
      today: dubaiDay(),
    });
    return drawLabel({ size, printer, sheet, design: printDesign, content, words, measurer });
  }, [
    size,
    designQuery.data,
    design,
    addEnglish,
    props.item,
    props.rateBp,
    units.data,
    showPrice,
    expiry,
    batch,
    printer,
    sheet,
    words,
    measurer,
  ]);
  const layout = drawn?.layout;
  // Exactly the dots the printer gets: the preview and the print dialog show the same thing.
  const imageUrl = useMemo(() => (drawn?.image ? printedDotsUrl(drawn.image) : ''), [drawn]);
  const refused = layout && !layout.ok ? layout.reason : null;

  /** Tells the server what was printed, with the price on the label (decision 0099). */
  const record = async (copies: number) => {
    if (!size || !designQuery.data) return;
    try {
      const result = await recordPrints.mutateAsync({
        sizeId: size.id,
        designVersionId: designQuery.data.versionId,
        source: 'item',
        lines: [
          {
            itemId: props.item.id,
            copies,
            price: printedPrice(props.item.price, props.rateBp, showPrice && canPrice),
          },
        ],
      });
      setProblem(result.priceChanged.length > 0 ? t('labels.priceChangedWhilePrinting') : null);
    } catch {
      // The labels are printed; only the record is missing (the item may then not show on the
      // "price changed" list later). Said plainly, without stopping anything.
      setProblem(t('labels.notRecorded'));
    }
  };

  // The print dialog (no label printer here, or A4 sheets): the drawn labels go into a print-only
  // container and the page size is set for this print only. Both stay until the printing has
  // really finished ("afterprint"): some print dialogs do not hold the screen.
  useEffect(() => {
    if (!dialogCopies || !size) return;
    const style = document.createElement('style');
    style.textContent = pageRule(size, sheet);
    document.head.appendChild(style);
    const copies = dialogCopies;
    const done = () => {
      setDialogCopies(0);
      setAskPrinted(copies);
    };
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
      await record(n);
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
        {(forSize.elements.expiry.show || forSize.elements.batch.show) && (
          <div className={mdStyles.grid2}>
            {forSize.elements.expiry.show && (
              <DateField label={t('labels.expiry')} value={expiry} onChange={setExpiry} />
            )}
            {forSize.elements.batch.show && (
              <TextField
                label={t('labels.batch')}
                value={batch}
                onChange={setBatch}
                ltr
                maxLength={20}
                autoComplete="off"
                hint={t('labels.extraHint')}
              />
            )}
          </div>
        )}
        <Switch isSelected={showPrice && canPrice} onChange={setShowPrice} isDisabled={!canPrice}>
          {t('labels.showPrice')}
        </Switch>
        <Switch
          isSelected={addEnglish || forSize.elements.nameEn.show}
          onChange={setAddEnglish}
          isDisabled={!props.item.nameEn?.trim() || forSize.elements.nameEn.show}
        >
          {t('labels.addEnglish')}
        </Switch>
        <Switch isSelected={sheet} onChange={setSheet}>
          {t('labels.sheet')}
        </Switch>
        {sizes.isSuccess && active.length === 0 && <Alert>{t('labels.noSizes')}</Alert>}
        {refused && (
          <Alert>
            {refused === 'too_small' && (expiry || batch.trim())
              ? t('labels.extrasTooMuch')
              : t(`labels.refused.${refused}`)}
          </Alert>
        )}
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
                texts: layout.texts.map((line) => ({ part: line.part, text: line.text })),
                prices: layout.prices.map((line) => line.runs),
                moduleDots: layout.bars.moduleDots,
              })}
            >
              <img
                className={`${styles.label} ${styles.zoomed}`}
                style={sizeVars(size)}
                src={imageUrl || undefined}
                alt={t('labels.barcodeOf', { code: props.item.primaryBarcode ?? props.item.code })}
              />
            </div>
            {layout.fitted && <Note>{t('labels.fitted')}</Note>}
          </div>
        )}
        {!silent && size && layout?.ok && (
          <Note>{t(sheet ? 'labels.sheetNote' : 'labels.dialogNote')}</Note>
        )}
        {askPrinted > 0 && (
          <Note>
            {t('labels.didPrint', { count: askPrinted })}{' '}
            <Button
              onPress={() => {
                const copies = askPrinted;
                setAskPrinted(0);
                void record(copies);
              }}
            >
              {t('labels.didPrintYes')}
            </Button>{' '}
            <Button onPress={() => setAskPrinted(0)}>{t('labels.didPrintNo')}</Button>
          </Note>
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
