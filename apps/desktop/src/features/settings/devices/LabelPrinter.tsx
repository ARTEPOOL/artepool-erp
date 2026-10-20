/**
 * Settings → Devices: the label printer of THIS PC (decision 0096). Kept on the server for this PC
 * (audited), so it survives a reinstall: the Windows printer, its dots per inch, how wide it prints,
 * and the X/Y offset. "Print test label" prints a border, a centre cross and a 5 mm ruler at the
 * label's real size: if the cross is not in the middle, move it with the offset and print again.
 * Only the Windows app reaches a printer; the preview shows the test label in any case.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Printer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  LabelPrinterConfig,
  type LabelSizeItem,
  type LabelPrinterConfig as LabelPrinterValues,
} from '@artepool/shared/contracts';
import { useSave } from '../../../api/hooks';
import { Alert, Button, Card, iconClass, Note, Segmented, TextField, useToast } from '../../../ui';
import { useErrorText } from '../../auth/context';
import {
  canPrintLabelsSilently,
  printLabels,
  THIS_DEVICE_KEY,
  useLabelPrinter,
} from '../../items/labels/printer';
import { renderTestLabel } from '../../items/labels/render';
import { localName, useLabelSizes } from '../../masterdata/refs';
import mdStyles from '../../masterdata/masterdata.module.css';
import { canPrintSilently, listPrinters } from '../../pos/receipt/printer';
import { CardHead, settingsClasses as styles } from '../parts';
import deviceStyles from './devices.module.css';

interface Form {
  printer: string;
  dpi: '203' | '300';
  printableWidthMm: string;
  offsetXMm: string;
  offsetYMm: string;
}

const toForm = (c: LabelPrinterValues): Form => ({
  printer: c.printer ?? '',
  dpi: String(c.dpi) as Form['dpi'],
  printableWidthMm: String(c.printableWidthMm),
  offsetXMm: String(c.offsetXMm),
  offsetYMm: String(c.offsetYMm),
});

/** A number of millimetres with at most one decimal ("1.5", "-0.5"), or null. */
const mm = (text: string): number | null =>
  /^-?\d{1,3}(\.\d)?$/.test(text.trim()) ? Number(text.trim()) : null;

/** The form as the server takes it, or null when a value is wrong. */
function toConfig(form: Form): LabelPrinterValues | null {
  const parsed = LabelPrinterConfig.safeParse({
    printer: form.printer || null,
    dpi: Number(form.dpi),
    printableWidthMm: mm(form.printableWidthMm),
    offsetXMm: mm(form.offsetXMm),
    offsetYMm: mm(form.offsetYMm),
  });
  return parsed.success ? parsed.data : null;
}

const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}`;

export function LabelPrinterCard({ index }: { index: number }) {
  const { t, i18n } = useTranslation('settings');
  const toast = useToast();
  const errorText = useErrorText();
  const name = localName(i18n.language);
  const native = canPrintSilently();
  const saved = useLabelPrinter();
  const sizes = (useLabelSizes().data ?? [])
    .filter((s) => s.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const [form, setForm] = useState<Form | null>(null);
  const [sizeId, setSizeId] = useState('');
  const [printers, setPrinters] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (saved.data && !form) setForm(toForm(saved.data));
  }, [saved.data, form]);
  useEffect(() => {
    if (!native) return;
    listPrinters()
      .then(setPrinters)
      .catch(() => setProblem(t('devices.printerListFailed')));
  }, [native, t]);

  const save = useSave(
    (api, body: LabelPrinterValues, key) =>
      api.put('/api/v1/devices/me/label-printer', body, { idempotencyKey: key }),
    {
      invalidate: [THIS_DEVICE_KEY],
      onSuccess: () => {
        setProblem(null);
        toast(t('devices.printerSaved'));
      },
    },
  );

  const config = useMemo(() => (form ? toConfig(form) : null), [form]);
  const size: LabelSizeItem | undefined = sizes.find((s) => s.id === sizeId) ?? sizes[0];
  const test = useMemo(() => {
    if (!config || !size) return null;
    const caption = t('devices.labelTestCaption', {
      width: size.widthMm,
      height: size.heightMm,
      dpi: config.dpi,
      x: signed(config.offsetXMm),
      y: signed(config.offsetYMm),
    });
    try {
      return renderTestLabel(
        { ...size, dpi: config.dpi, printableWidthMm: config.printableWidthMm },
        { x: config.offsetXMm, y: config.offsetYMm },
        caption,
      );
    } catch {
      // No canvas to draw on (only in some test browsers): no preview, nothing to print.
      return null;
    }
  }, [config, size, t]);

  if (!form) return null;
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const bad = (text: string, min: number, max: number) => {
    const value = mm(text);
    return value === null || value < min || value > max
      ? t('devices.labelMmRule', { min, max })
      : undefined;
  };

  const printTest = async () => {
    if (!config || !size || !test) return;
    const outcome = await printLabels(test, size, config, 1, 'test-label');
    if (outcome.printed) {
      setProblem(null);
      toast(t('devices.testSent'));
    } else {
      setProblem(t(`devices.labelProblem.${outcome.reason}`));
    }
  };

  return (
    <Card rise index={index}>
      <CardHead title={t('devices.labelPrinter')} />
      <p className={styles.helpText}>{t('devices.labelPrinterHelp')}</p>
      {native ? (
        <select
          className={deviceStyles.warehouseSelect}
          aria-label={t('devices.labelPrinter')}
          value={form.printer}
          onChange={(event) => set({ printer: event.target.value })}
        >
          <option value="">{t('devices.noPrinter')}</option>
          {[...new Set([...printers, ...(form.printer ? [form.printer] : [])])].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      ) : (
        <Note>{t('devices.printerWindowsOnly')}</Note>
      )}
      <Segmented<Form['dpi']>
        label={t('devices.labelDpi')}
        value={form.dpi}
        onChange={(dpi) => set({ dpi })}
        options={[
          { value: '203', label: t('devices.labelDpiValue', { dpi: 203 }) },
          { value: '300', label: t('devices.labelDpiValue', { dpi: 300 }) },
        ]}
      />
      <div className={mdStyles.grid3}>
        <TextField
          label={t('devices.labelPrintableWidth')}
          value={form.printableWidthMm}
          onChange={(printableWidthMm) => set({ printableWidthMm })}
          ltr
          inputMode="decimal"
          maxLength={5}
          hint={t('devices.labelPrintableWidthHint')}
          error={bad(form.printableWidthMm, 20, 120)}
        />
        <TextField
          label={t('devices.labelOffsetX')}
          value={form.offsetXMm}
          onChange={(offsetXMm) => set({ offsetXMm })}
          ltr
          inputMode="decimal"
          maxLength={5}
          hint={t('devices.labelOffsetXHint')}
          error={bad(form.offsetXMm, -10, 10)}
        />
        <TextField
          label={t('devices.labelOffsetY')}
          value={form.offsetYMm}
          onChange={(offsetYMm) => set({ offsetYMm })}
          ltr
          inputMode="decimal"
          maxLength={5}
          hint={t('devices.labelOffsetYHint')}
          error={bad(form.offsetYMm, -10, 10)}
        />
      </div>
      <div className={styles.savebar}>
        <Button
          variant="primary"
          isDisabled={!config}
          busy={save.isPending}
          onPress={() =>
            config && save.mutate(config, { onError: (caught) => setProblem(errorText(caught)) })
          }
        >
          {t('devices.labelSave')}
        </Button>
      </div>
      {sizes.length > 0 && (
        <div className={deviceStyles.labelTest}>
          <select
            className={deviceStyles.warehouseSelect}
            aria-label={t('devices.labelTestSize')}
            value={size?.id ?? ''}
            onChange={(event) => setSizeId(event.target.value)}
          >
            {sizes.map((s) => (
              <option key={s.id} value={s.id}>
                {`${name(s)} (${s.widthMm} × ${s.heightMm})`}
              </option>
            ))}
          </select>
          <Button
            variant="default"
            isDisabled={!test || !canPrintLabelsSilently(config ?? undefined)}
            onPress={() => void printTest()}
          >
            <Printer className={iconClass.sm} aria-hidden="true" />
            {t('devices.labelTestPrint')}
          </Button>
          {test && size && (
            <img
              className={deviceStyles.labelPreview}
              style={
                {
                  '--label-w': `${size.widthMm}mm`,
                  '--label-h': `${size.heightMm}mm`,
                } as CSSProperties
              }
              src={test.canvas.toDataURL('image/png')}
              alt={t('devices.labelTestPreview')}
              data-testid="label-test-preview"
            />
          )}
        </div>
      )}
      {problem && <Alert>{problem}</Alert>}
      <Note>{t('devices.labelPrinterNote')}</Note>
    </Card>
  );
}
