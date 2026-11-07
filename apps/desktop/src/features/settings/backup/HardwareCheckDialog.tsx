/**
 * The guided hardware check (M7 part D, decision 0119), on the PC being checked, about 5 minutes.
 * On a POS PC: a test receipt, the drawer, a test label, and the scan of that label's barcode (the
 * app says whether the code read matches the one printed). On an office PC or the laptop: an A4
 * test page through the print dialog. Each step is «تمام» or «فيه مشكلة», with an optional note.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_LABEL_PRINTER,
  defaultLabelDesign,
  type FilePayload,
  type HardwareCheck,
  type HardwareCheckRequest,
  type HardwareOutcome,
  type HardwareStep,
  type LabelPrinterConfig,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { dubaiDay } from '../../../lib/format';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogFooter,
  Segmented,
  TextField,
  useToast,
} from '../../../ui';
import { useErrorText } from '../../auth/context';
import { gs1CheckDigit } from '../../items/labels/barcode';
import { drawLabel, labelContent, useLabelDesign } from '../../items/labels/design';
import { printLabels, useLabelPrinter } from '../../items/labels/printer';
import { canvasMeasurer } from '../../items/labels/render';
import { labelWords } from '../../items/labels/words';
import { useLabelSizes } from '../../masterdata/refs';
import { renderReceipt } from '../../pos/receipt/render';
import {
  canPrintSilently,
  kickDrawer,
  printImage,
  type PrintOutcome,
} from '../../pos/receipt/printer';
import { printPdf } from '../../sales/print';
import { settingsClasses } from '../parts';
import styles from './backup.module.css';

export const HARDWARE_KEY = ['settings', 'hardware-checks'] as const;

/** An in-store EAN-13 (prefix 2): never the barcode of a real item from a supplier. */
export function testBarcode(random: () => number = Math.random): string {
  const body = `2${Array.from({ length: 11 }, () => Math.floor(random() * 10)).join('')}`;
  return `${body}${gs1CheckDigit(body)}`;
}

/** What the scanner typed matches the printed code (spaces and a trailing Enter aside). */
export const scanMatches = (typed: string, printed: string): boolean =>
  typed.replace(/\s+/g, '') === printed;

type Answer = { outcome: HardwareOutcome | null; note: string };

export function HardwareCheckDialog(props: { steps: HardwareStep[]; onClose: () => void }) {
  const { t, i18n } = useTranslation('settings');
  const api = useApi();
  const toast = useToast();
  const errorText = useErrorText();
  const [answers, setAnswers] = useState<Record<string, Answer>>(() =>
    Object.fromEntries(props.steps.map((s) => [s, { outcome: null, note: '' }])),
  );
  const [said, setSaid] = useState<Record<string, string>>({});
  const [scanned, setScanned] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const barcode = useMemo(() => testBarcode(), []);
  const sizes = useLabelSizes();
  const design = useLabelDesign();
  const printer: LabelPrinterConfig = useLabelPrinter().data ?? DEFAULT_LABEL_PRINTER;
  const measurer = useMemo(() => canvasMeasurer(), []);
  const words = useMemo(() => labelWords(i18n), [i18n]);
  const save = useSave(
    (a, body: HardwareCheckRequest, key) =>
      a.post<HardwareCheck>('/api/v1/system/hardware-checks', body, { idempotencyKey: key }),
    {
      invalidate: [[...HARDWARE_KEY]],
      onSuccess: (check) => {
        toast(check.allOk ? t('hardware.savedOk') : t('hardware.savedProblem'));
        props.onClose();
      },
    },
  );

  const answer = (step: HardwareStep, patch: Partial<Answer>) =>
    setAnswers((all) => ({ ...all, [step]: { ...all[step]!, ...patch } }));
  const report = (step: HardwareStep, outcome: PrintOutcome | { printed: false; reason: string }) =>
    setSaid((all) => ({
      ...all,
      [step]: outcome.printed ? t('hardware.sent') : t(`hardware.printProblem.${outcome.reason}`),
    }));

  const actions: Record<HardwareStep, () => Promise<void>> = {
    receipt: async () => {
      // Only the Windows app reaches a printer (and draws the receipt).
      if (!canPrintSilently()) return report('receipt', { printed: false, reason: 'browser' });
      const tAr = i18n.getFixedT('ar', 'settings');
      const tEn = i18n.getFixedT('en', 'settings');
      const image = renderReceipt({
        dir: 'rtl',
        lines: [
          {
            kind: 'text',
            text: tAr('hardware.receiptTitle'),
            align: 'center',
            size: 'l',
            bold: true,
          },
          {
            kind: 'text',
            text: tEn('hardware.receiptTitle'),
            align: 'center',
            size: 'l',
            bold: true,
          },
          { kind: 'rule' },
          { kind: 'pair', label: 'عربي / English', value: '1234.50' },
          { kind: 'text', text: tAr('devices.testReceiptBody'), align: 'start', size: 's' },
          { kind: 'text', text: tEn('devices.testReceiptBody'), align: 'start', size: 's' },
          { kind: 'rule', heavy: true },
        ],
      });
      report('receipt', await printImage(image, 'hardware-check'));
    },
    drawer: async () => report('drawer', await kickDrawer()),
    label: async () => {
      if (!canPrintSilently()) return report('label', { printed: false, reason: 'browser' });
      const size = (sizes.data ?? [])
        .filter((s) => s.isActive)
        .sort((a, b) => a.sortOrder - b.sortOrder)[0];
      if (!size) return report('label', { printed: false, reason: 'no_size' });
      const labelDesign = design.data?.design ?? defaultLabelDesign();
      const content = labelContent(
        {
          nameAr: t('hardware.labelName', { lng: 'ar' }),
          nameEn: t('hardware.labelName', { lng: 'en' }),
          code: 'TEST',
          primaryBarcode: barcode,
          price: null,
          packAr: null,
          packEn: null,
          unitId: '',
        },
        {
          design: labelDesign,
          shopName: design.data?.shopName ?? null,
          units: [],
          rateBp: undefined,
          withPrice: false,
          extras: { expiry: '', batch: '' },
          today: dubaiDay(),
        },
      );
      const drawn = drawLabel({ size, printer, design: labelDesign, content, words, measurer });
      if (!drawn.image) return report('label', { printed: false, reason: 'failed' });
      report('label', await printLabels(drawn.image, size, printer, 1, 'hardware-check'));
    },
    scan: () => Promise.resolve(),
    a4: async () => {
      try {
        await printPdf(await api.get<FilePayload>('/api/v1/system/hardware-checks/a4-test-page'));
        setSaid((all) => ({ ...all, a4: t('hardware.a4Sent') }));
      } catch (e) {
        setProblem(errorText(e));
      }
    },
  };

  const complete = props.steps.every((s) => answers[s]?.outcome);
  const matched = scanned.trim() !== '' && scanMatches(scanned, barcode);

  return (
    <Dialog isOpen onClose={props.onClose} title={t('hardware.title')}>
      <div className={styles.form} data-testid="hardware-dialog">
        <p className={settingsClasses.helpText}>{t('hardware.intro')}</p>
        {problem && <Alert>{problem}</Alert>}
        <ol className={styles.checks}>
          {props.steps.map((step, i) => (
            <li key={step} data-testid={`hardware-step-${step}`}>
              <b>
                {i + 1}. {t(`hardware.step.${step}`)}
              </b>
              <div className={styles.muted}>{t(`hardware.help.${step}`)}</div>
              {step === 'scan' ? (
                <>
                  <TextField
                    label={t('hardware.scanHere')}
                    value={scanned}
                    ltr
                    autoComplete="off"
                    onChange={(value) => {
                      setScanned(value);
                      if (scanMatches(value, barcode)) answer('scan', { outcome: 'ok' });
                      else if (answers.scan?.outcome === 'ok') answer('scan', { outcome: null });
                    }}
                  />
                  {scanned.trim() !== '' && (
                    <span data-testid="hardware-scan-result">
                      <Chip tone={matched ? 'ok' : 'danger'}>
                        {matched ? t('hardware.scanMatches') : t('hardware.scanDiffers')}
                      </Chip>
                    </span>
                  )}
                </>
              ) : (
                <Button onPress={() => void actions[step]()}>{t(`hardware.action.${step}`)}</Button>
              )}
              {said[step] && <div className={styles.muted}>{said[step]}</div>}
              <Segmented<HardwareOutcome>
                label={t(`hardware.step.${step}`)}
                value={answers[step]?.outcome ?? ('' as HardwareOutcome)}
                // The scan is OK only when the code read is the one printed on the label.
                options={[
                  ...(step !== 'scan' || matched
                    ? [{ value: 'ok' as const, label: t('hardware.ok') }]
                    : []),
                  { value: 'problem', label: t('hardware.problem') },
                ]}
                onChange={(outcome) => answer(step, { outcome })}
              />
              {answers[step]?.outcome === 'problem' && (
                <TextField
                  label={t('hardware.note')}
                  value={answers[step].note}
                  maxLength={500}
                  onChange={(note) => answer(step, { note })}
                />
              )}
            </li>
          ))}
        </ol>
        <DialogFooter>
          <Button onPress={props.onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            busy={save.isPending}
            isDisabled={!complete}
            onPress={() =>
              save.mutate(
                {
                  results: props.steps.map((step) => ({
                    step,
                    outcome: answers[step]!.outcome!,
                    note: answers[step]!.note.trim() || null,
                  })),
                },
                { onError: (e) => setProblem(errorText(e)) },
              )
            }
          >
            {t('hardware.save')}
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}
