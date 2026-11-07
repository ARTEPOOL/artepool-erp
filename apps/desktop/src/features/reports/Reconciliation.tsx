/**
 * The reconciliation report (M7, decision 0119): the seven steps of the acceptance
 * reconciliation (stock, cash, invoices, VAT, accounts, audit, backup), each green or red, with
 * its figures and the problems found, and a PDF for the accountant. Owner and accountant; the
 * server refuses everyone else.
 */
import { useState } from 'react';
import { CheckCircle2, Printer, ShieldCheck, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  FilePayload,
  ReconciliationFigure,
  ReconciliationReport,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../api/hooks';
import { dubaiDay } from '../../lib/format';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Chip,
  iconClass,
  Note,
  PageHeader,
  tableClasses,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { DateField } from '../invoices/parts';
import { money } from '../masterdata/format';
import { printPdf } from '../sales/print';
import styles from './dashboard.module.css';

/** 05/11/2026, kept left to right inside Arabic text. */
const day = (iso: string) => `⁦${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}⁩`;

export function Reconciliation() {
  const { t } = useTranslation('settings');
  const api = useApi();
  const can = useCan();
  const errorText = useErrorText();
  const [from, setFrom] = useState(dubaiDay());
  const [to, setTo] = useState(dubaiDay());
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [printing, setPrinting] = useState(false);
  const run = useSave(
    (client, body: { from: string; to: string }, key) =>
      client.post<ReconciliationReport>('/api/v1/reports/reconciliation', body, {
        idempotencyKey: key,
      }),
    { onSuccess: (result) => setReport(result) },
  );
  if (!can('reports.reconciliation')) return <Note>{t('reconciliation.noAccess')}</Note>;

  const figureLabel = (key: string) =>
    key.startsWith('series:')
      ? t('reconciliation.series', { code: key.slice('series:'.length) })
      : t(`reconciliation.figures.${key}`);
  const figureValue = (f: ReconciliationFigure) => {
    if (f.value === null) return t('reconciliation.hidden');
    if (f.kind === 'fils') return `${money(BigInt(f.value))} ${t('dashboard.aed')}`;
    if (f.key === 'lastRestoreTest') return day(f.value.slice(0, 10));
    if (f.key === 'lastRestoreResult') return t(`reconciliation.restoreResult.${f.value}`);
    return f.value;
  };
  const print = async () => {
    if (!report) return;
    setPrinting(true);
    try {
      await printPdf(await api.get<FilePayload>(`/api/v1/reports/reconciliation/${report.id}/pdf`));
    } finally {
      setPrinting(false);
    }
  };
  const invalid = from === '' || to === '' || from > to;

  return (
    <>
      <PageHeader
        title={t('reconciliation.title')}
        subtitle={
          report
            ? t('reconciliation.range', { from: day(report.from), to: day(report.to) })
            : t('reconciliation.subtitle')
        }
        tools={
          <>
            <DateField label={t('reconciliation.from')} value={from} onChange={setFrom} />
            <DateField label={t('reconciliation.to')} value={to} onChange={setTo} />
            <Button
              variant="primary"
              busy={run.isPending}
              isDisabled={invalid}
              onPress={() => run.mutate({ from, to })}
            >
              <ShieldCheck aria-hidden="true" />
              {t('reconciliation.run')}
            </Button>
            {report && (
              <Button busy={printing} onPress={() => void print()}>
                <Printer aria-hidden="true" />
                {t('reconciliation.print')}
              </Button>
            )}
          </>
        }
      />
      {run.error ? <Alert>{errorText(run.error)}</Alert> : null}
      {!report && !run.isPending && <Note>{t('reconciliation.explain')}</Note>}
      {report && (
        <div className={styles.reconciliation} data-testid="reconciliation">
          {report.ok ? (
            <Note>
              <CheckCircle2 aria-hidden="true" /> {t('reconciliation.allOk')}
            </Note>
          ) : (
            <Alert tone="warn">{t('reconciliation.someBad')}</Alert>
          )}
          {report.steps.map((step, i) => (
            <div key={step.step} data-testid={`step-${step.step}`} data-ok={step.ok}>
              <Card>
                <CardHeader title={`${i + 1}. ${t(`reconciliation.steps.${step.step}`)}`}>
                  <Chip
                    tone={step.ok ? 'ok' : 'danger'}
                    icon={
                      step.ok ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />
                    }
                  >
                    {step.ok ? t('reconciliation.ok') : t('reconciliation.bad')}
                  </Chip>
                </CardHeader>
                <ul className={styles.checks}>
                  {step.checks.map((c) => (
                    <li key={c.name} data-ok={c.ok}>
                      {c.ok ? (
                        <CheckCircle2 className={iconClass.sm} aria-hidden="true" />
                      ) : (
                        <XCircle className={iconClass.sm} aria-hidden="true" />
                      )}
                      <span>{t(`reconciliation.checks.${c.name}`)}</span>
                      {!c.ok && (
                        <ul className={styles.examples}>
                          {c.examples.map((e) => (
                            <li key={e}>
                              <bdi>{e}</bdi>
                            </li>
                          ))}
                          {c.problems > c.examples.length && (
                            <li>
                              {t('reconciliation.more', { n: c.problems - c.examples.length })}
                            </li>
                          )}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
                {step.figures.length > 0 && (
                  <table className={tableClasses.table}>
                    <tbody>
                      {step.figures.map((f) => (
                        <tr key={f.key}>
                          <td>{figureLabel(f.key)}</td>
                          <td className={tableClasses.num}>
                            <bdi>{figureValue(f)}</bdi>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
