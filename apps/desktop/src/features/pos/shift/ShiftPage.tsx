/**
 * The cashier's own shift (design 08; decisions 0004, 0006, 0056–0058): paid-in / paid-out with a
 * reason, cash drops and float top-ups, No Sale, the X report, and the close — a blind count by
 * denomination (the expected amount appears only after counting), one recount with a supervisor's
 * approval, then the Z report.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  DoorOpen,
  FileBarChart,
  Lock,
  Vault,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ShiftReport } from '@artepool/shared/contracts';
import { Alert, Button, Card, CardHeader, iconClass, Note, PageHeader } from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { usePosState, useXReport } from '../api';
import { CloseShiftDialog } from './CloseShiftDialog';
import { MovementDialog, type MovementKind } from './MovementDialog';
import { NoSaleDialog } from './NoSaleDialog';
import { ShiftReportView } from './ShiftReportView';
import styles from '../pos.module.css';

export function ShiftPage() {
  const { t } = useTranslation('pos');
  const can = useCan();
  const errorText = useErrorText();
  const state = usePosState();
  const shift = state.data?.shift ?? null;
  const [moving, setMoving] = useState<MovementKind | null>(null);
  const [noSale, setNoSale] = useState(false);
  const [closing, setClosing] = useState(false);
  const [showX, setShowX] = useState(false);
  const [closed, setClosed] = useState<ShiftReport | null>(null);
  const x = useXReport(showX && shift !== null);

  if (closed) {
    return (
      <>
        <PageHeader title={t('shiftPage.zTitle')} />
        <ShiftReportView report={closed} printable />
        <div className={styles.payRow}>
          <Link to="/pos" className={styles.linkButton}>
            {t('shiftPage.backToPos')}
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('shiftPage.title')}
        subtitle={shift ? t('shiftPage.subtitle', { number: shift.shiftNumber }) : undefined}
        tools={
          <Link to="/pos" className={styles.linkButton}>
            {t('shiftPage.backToPos')}
          </Link>
        }
      />
      {state.error && <Alert>{errorText(state.error)}</Alert>}
      {!state.isLoading && !shift && <Note>{t('shiftPage.noShift')}</Note>}
      {shift && (
        <>
          {state.data?.dropDue && <Alert tone="warn">{t('dropDueLong')}</Alert>}
          <div className={styles.actionsGrid}>
            <Card>
              <CardHeader title={t('shiftPage.cash')} />
              <div className={styles.actionButtons}>
                <Button isDisabled={!can('cash.paid_in')} onPress={() => setMoving('paid_in')}>
                  <ArrowDownToLine className={iconClass.sm} aria-hidden="true" />
                  {t('movement.paid_in')}
                </Button>
                <Button onPress={() => setMoving('paid_out')}>
                  <ArrowUpFromLine className={iconClass.sm} aria-hidden="true" />
                  {t('movement.paid_out')}
                </Button>
                <Button isDisabled={!can('cash.drop')} onPress={() => setMoving('cash_drop')}>
                  <Vault className={iconClass.sm} aria-hidden="true" />
                  {t('movement.cash_drop')}
                </Button>
                <Button isDisabled={!can('cash.drop')} onPress={() => setMoving('float_top_up')}>
                  <Vault className={iconClass.sm} aria-hidden="true" />
                  {t('movement.float_top_up')}
                </Button>
                {can('pos.no_sale') && (
                  <Button onPress={() => setNoSale(true)}>
                    <DoorOpen className={iconClass.sm} aria-hidden="true" />
                    {t('noSale.button')}
                  </Button>
                )}
              </div>
            </Card>
            <Card>
              <CardHeader title={t('shiftPage.reports')} />
              <div className={styles.actionButtons}>
                <Button isDisabled={!can('reports.x')} onPress={() => setShowX((v) => !v)}>
                  <FileBarChart className={iconClass.sm} aria-hidden="true" />
                  {t('shiftPage.xReport')}
                </Button>
                <Button
                  variant="primary"
                  isDisabled={!can('shifts.close')}
                  onPress={() => setClosing(true)}
                >
                  <Lock className={iconClass.sm} aria-hidden="true" />
                  {t('shiftPage.close')}
                </Button>
              </div>
              <Note>{t('shiftPage.closeHelp')}</Note>
            </Card>
          </div>
          {showX && x.data && <ShiftReportView report={x.data} />}
          {showX && x.error && <Alert>{errorText(x.error)}</Alert>}
        </>
      )}
      {moving && <MovementDialog kind={moving} onClose={() => setMoving(null)} />}
      {noSale && <NoSaleDialog onClose={() => setNoSale(false)} />}
      {closing && state.data && (
        <CloseShiftDialog
          state={state.data}
          onClose={() => setClosing(false)}
          onClosed={(report) => {
            setClosing(false);
            setClosed(report);
          }}
        />
      )}
    </>
  );
}
