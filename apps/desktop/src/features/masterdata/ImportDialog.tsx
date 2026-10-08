import { useState, type ReactNode } from 'react';
import { CheckCircle2, Download, FileSpreadsheet, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  FilePayload,
  ImportCheckResponse,
  ImportCommitResponse,
  ImportEntity,
  ImportFileRequest,
} from '@artepool/shared/contracts';
import { IMPORT_MAX_BYTES } from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { useApi, useSave } from '../../api/hooks';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogFooter,
  iconClass,
  InfoBar,
  tableClasses as tbl,
  useToast,
} from '../../ui';
import { useErrorText } from '../auth/context';
import { downloadFile, readAsBase64 } from './files';
import styles from './masterdata.module.css';
import type { QueryKey } from '@tanstack/react-query';

interface Chosen {
  name: string;
  dataBase64: string;
}

/**
 * Excel import (decision 0031): download the template, choose the filled file, Check (nothing is
 * saved; every problem is listed by row and column), then Import — all rows in one go, or none.
 */
export function ImportDialog(props: {
  entity: ImportEntity;
  title: ReactNode;
  intro: ReactNode;
  invalidate: QueryKey[];
  onClose: () => void;
}) {
  const { t } = useTranslation('masterdata');
  const api = useApi();
  const errorText = useErrorText();
  const toast = useToast();
  const [file, setFile] = useState<Chosen | null>(null);
  const [report, setReport] = useState<ImportCheckResponse | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const check = useSave((a, body: ImportFileRequest, key) =>
    a.post<ImportCheckResponse>(`/api/v1/imports/${props.entity}/check`, body, {
      idempotencyKey: key,
    }),
  );
  const commit = useSave(
    (a, input: { batchId: string; body: ImportFileRequest }, key) =>
      a.post<ImportCommitResponse>(
        `/api/v1/imports/${props.entity}/${input.batchId}/commit`,
        input.body,
        { idempotencyKey: key },
      ),
    {
      invalidate: props.invalidate,
      onSuccess: (result) => {
        toast(t('import.done', { count: result.imported }));
        props.onClose();
      },
    },
  );

  const template = async () => {
    setDownloading(true);
    try {
      downloadFile(await api.get<FilePayload>(`/api/v1/imports/${props.entity}/template`));
    } catch (error) {
      setFileProblem(errorText(error));
    } finally {
      setDownloading(false);
    }
  };

  const choose = async (chosen: File | undefined) => {
    setReport(null);
    setFileProblem(null);
    check.reset();
    commit.reset();
    if (!chosen) return setFile(null);
    if (chosen.size > IMPORT_MAX_BYTES) {
      setFile(null);
      return setFileProblem(t('import.file.too_large'));
    }
    setFile({ name: chosen.name, dataBase64: await readAsBase64(chosen) });
  };

  const runCheck = () => {
    if (!file) return;
    check.mutate({ fileName: file.name, dataBase64: file.dataBase64 }, { onSuccess: setReport });
  };

  const problemOf = (error: unknown): string => {
    if (error instanceof ApiError && error.details.part === 'file') {
      const issue = (error.details.issues as { code?: string }[] | undefined)?.[0]?.code;
      if (issue) return t(`import.file.${issue}`, { defaultValue: errorText(error) });
    }
    return errorText(error);
  };

  const failure = check.error ?? commit.error;

  return (
    <Dialog isOpen onClose={props.onClose} title={props.title} wide>
      <div className={styles.form}>
        <p>{props.intro}</p>
        <div className={styles.row}>
          <Button onPress={() => void template()} busy={downloading}>
            <Download className={iconClass.sm} aria-hidden="true" />
            {t('import.template')}
          </Button>
        </div>
        <label className={styles.fileInput}>
          <span className={styles.strong}>{t('import.file.label')}</span>
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => void choose(e.target.files?.[0])}
          />
          <span className={styles.muted}>{t('import.file.hint')}</span>
        </label>
        {fileProblem && <Alert>{fileProblem}</Alert>}
        {failure !== null && <Alert>{problemOf(failure)}</Alert>}

        {report && (
          <>
            <div className={styles.summary}>
              <div>
                <span>{t('import.report.rows')}</span>
                <b>
                  <bdi>{report.rowsTotal}</bdi>
                </b>
              </div>
              <div className={styles.good}>
                <span>{t('import.report.valid')}</span>
                <b>
                  <bdi>{report.rowsValid}</bdi>
                </b>
              </div>
              <div className={report.rowsInvalid > 0 ? styles.bad : undefined}>
                <span>{t('import.report.invalid')}</span>
                <b>
                  <bdi>{report.rowsInvalid}</bdi>
                </b>
              </div>
            </div>
            {report.status === 'validated' ? (
              <Chip tone="ok" icon={<CheckCircle2 aria-hidden="true" />}>
                {t('import.report.ready', { count: report.rowsTotal })}
              </Chip>
            ) : (
              <>
                <Alert icon={<XCircle aria-hidden="true" />}>
                  {t('import.report.fix', { count: report.issuesTotal })}
                </Alert>
                <div className={styles.report}>
                  <table className={tbl.table} aria-label={t('import.report.label')}>
                    <thead>
                      <tr>
                        <th>{t('import.report.row')}</th>
                        <th>{t('import.report.column')}</th>
                        <th>{t('import.report.problem')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.issues.map((issue, i) => (
                        <tr key={i}>
                          <td>
                            <bdi>{issue.row}</bdi>
                          </td>
                          <td>{issue.column ?? '—'}</td>
                          <td>{t(`import.problems.${issue.problem}`)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {report.issuesTotal > report.issues.length && (
                  <p className={styles.muted}>
                    {t('import.report.more', { count: report.issuesTotal - report.issues.length })}
                  </p>
                )}
              </>
            )}
          </>
        )}
        <InfoBar icon={<FileSpreadsheet aria-hidden="true" />}>{t('import.allOrNothing')}</InfoBar>
        <DialogFooter>
          <Button onPress={props.onClose}>{t('actions.cancel')}</Button>
          {report?.status === 'validated' && file ? (
            <Button
              variant="primary"
              busy={commit.isPending}
              onPress={() =>
                commit.mutate({
                  batchId: report.batchId,
                  body: { fileName: file.name, dataBase64: file.dataBase64 },
                })
              }
            >
              {t('import.commit', { count: report.rowsTotal })}
            </Button>
          ) : (
            <Button variant="primary" busy={check.isPending} isDisabled={!file} onPress={runCheck}>
              {t('import.check')}
            </Button>
          )}
        </DialogFooter>
      </div>
    </Dialog>
  );
}
