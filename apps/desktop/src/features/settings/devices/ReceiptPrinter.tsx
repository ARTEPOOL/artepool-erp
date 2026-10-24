/**
 * Settings → Devices: the receipt printer of THIS PC (decisions 0008, 0055). Kept on this PC only;
 * the POS prints to it silently and the drawer, wired to the printer, opens through it. A test
 * receipt and a drawer test check the wiring. Only the Windows app can reach a printer.
 */
import { useEffect, useState } from 'react';
import { Printer, Landmark } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, iconClass, Note, useToast } from '../../../ui';
import { receiptJob } from '../../pos/receipt/escpos';
import { renderReceipt } from '../../pos/receipt/render';
import {
  canPrintSilently,
  kickDrawer,
  listPrinters,
  savedPrinter,
  savePrinter,
  sendJob,
  type PrintOutcome,
} from '../../pos/receipt/printer';
import { CardHead, settingsClasses as styles } from '../parts';
import deviceStyles from './devices.module.css';

export function ReceiptPrinterCard({ index }: { index: number }) {
  const { t, i18n } = useTranslation('settings');
  const toast = useToast();
  const native = canPrintSilently();
  const [printers, setPrinters] = useState<string[]>([]);
  const [chosen, setChosen] = useState(savedPrinter() ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!native) return;
    listPrinters()
      .then(setPrinters)
      .catch(() => setProblem(t('devices.printerListFailed')));
  }, [native, t]);

  const report = (outcome: PrintOutcome, done: string) => {
    if (outcome.printed) {
      setProblem(null);
      toast(done);
    } else {
      setProblem(t(`devices.printerProblem.${outcome.reason}`));
    }
  };

  const testReceipt = async () => {
    const tAr = i18n.getFixedT('ar', 'settings');
    const tEn = i18n.getFixedT('en', 'settings');
    const image = renderReceipt({
      dir: 'rtl',
      lines: [
        {
          kind: 'text',
          text: tAr('devices.testReceiptTitle'),
          align: 'center',
          size: 'l',
          bold: true,
        },
        {
          kind: 'text',
          text: tEn('devices.testReceiptTitle'),
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
    report(
      await sendJob(receiptJob({ ...image, kickDrawer: false }), 'test'),
      t('devices.testSent'),
    );
  };

  return (
    <Card rise index={index}>
      <CardHead title={t('devices.receiptPrinter')} />
      <p className={styles.helpText}>{t('devices.receiptPrinterHelp')}</p>
      {!native ? (
        <Note>{t('devices.printerWindowsOnly')}</Note>
      ) : (
        <>
          <select
            className={deviceStyles.warehouseSelect}
            aria-label={t('devices.receiptPrinter')}
            value={chosen}
            onChange={(event) => {
              setChosen(event.target.value);
              savePrinter(event.target.value || null);
              toast(t('devices.printerSaved'));
            }}
          >
            <option value="">{t('devices.noPrinter')}</option>
            {printers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <div className={styles.savebar}>
            <Button variant="default" isDisabled={!chosen} onPress={() => void testReceipt()}>
              <Printer className={iconClass.sm} aria-hidden="true" />
              {t('devices.testPrint')}
            </Button>
            <Button
              variant="default"
              isDisabled={!chosen}
              onPress={() => void kickDrawer().then((o) => report(o, t('devices.drawerSent')))}
            >
              <Landmark className={iconClass.sm} aria-hidden="true" />
              {t('devices.testDrawer')}
            </Button>
          </div>
        </>
      )}
      {problem && <Alert>{problem}</Alert>}
      <Note>{t('devices.printerA4')}</Note>
    </Card>
  );
}
