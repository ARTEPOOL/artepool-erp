import { useState, type FormEvent } from 'react';
import { CircleDashed, ListOrdered, Lock, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SeriesItem, SeriesResponse, UpdateSeriesRequest } from '@artepool/shared/contracts';
import { asciiDigits } from '@artepool/shared';
import { useApi, useSave } from '../../../api/hooks';
import {
  Alert,
  Button,
  Card,
  Chip,
  cx,
  Dialog,
  DialogFooter,
  iconClass,
  Note,
  tableClasses,
  TextField,
  useToast,
} from '../../../ui';
import { MD_KEYS } from '../../masterdata/refs';
import { CardHead, settingsClasses } from '../parts';
import { SaveProblem } from '../company/SaveProblem';
import styles from './tax.module.css';

/** The translation key of a series' document type, e.g. `invoice_pos`, `credit_note`. */
export const seriesKey = (series: Pick<SeriesItem, 'docType' | 'channel'>): string =>
  series.channel ? `${series.docType}_${series.channel}` : series.docType;

/** The number a series would give first with these settings, e.g. "POS-000001". */
export function preview(prefix: string, width: number, start: string): string {
  return `${prefix}${start.padStart(width, '0')}`;
}

const PREFIX = /^[A-Z0-9-]{1,16}$/;
const START = /^[1-9][0-9]{0,17}$/;

/**
 * Design 13 → VAT & numbering → "Document numbering" (decision 0011): gapless series; a number
 * is taken only when a document is issued. Prefix, width and start can change only before the
 * first number (owner only, `system.series.manage`).
 */
export function SeriesCard({ index }: { index: number }) {
  const { t, i18n } = useTranslation('setup');
  const api = useApi();
  const [editing, setEditing] = useState<SeriesItem | null>(null);
  const series = useQuery({
    queryKey: MD_KEYS.series,
    queryFn: async () => (await api.get<SeriesResponse>('/api/v1/settings/series')).series,
  });
  const name = (item: SeriesItem) => {
    const key = `tax.series.names.${seriesKey(item)}`;
    return i18n.exists(`setup:${key}`) ? t(key) : item.code;
  };

  return (
    <Card rise index={index} padding="table">
      <div className={settingsClasses.tblHead}>
        <CardHead title={t('tax.series.title')}>
          <Chip icon={<ListOrdered aria-hidden="true" />}>{t('tax.series.gapless')}</Chip>
        </CardHead>
      </div>
      <table className={tableClasses.table}>
        <thead>
          <tr>
            <th>{t('tax.series.document')}</th>
            <th>{t('tax.series.prefix')}</th>
            <th className={tableClasses.num}>{t('tax.series.next')}</th>
            <th>{t('tax.series.status')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(series.data ?? [])
            .filter((item) => item.isActive)
            .map((item) => (
              <tr key={item.id}>
                <td>{name(item)}</td>
                <td>
                  <bdi>{item.prefix}</bdi>
                </td>
                <td className={tableClasses.num}>
                  <b>
                    <bdi>{item.nextFormatted}</bdi>
                  </b>
                </td>
                <td>
                  {item.used ? (
                    <Chip tone="info" icon={<Lock aria-hidden="true" />}>
                      {t('tax.series.inUse')}
                    </Chip>
                  ) : (
                    <Chip icon={<CircleDashed aria-hidden="true" />}>{t('tax.series.unused')}</Chip>
                  )}
                </td>
                <td className={tableClasses.num}>
                  {item.used ? (
                    <span className={cx(tableClasses.sub, styles.fixed)}>
                      {t('tax.series.fixed')}
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      aria-label={t('tax.series.editOne', { name: name(item) })}
                      onPress={() => setEditing(item)}
                    >
                      <Pencil className={iconClass.sm} aria-hidden="true" />
                      {t('tax.series.edit')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          {series.isPending && (
            <tr className={tableClasses.empty}>
              <td colSpan={5}>{t('loading')}</td>
            </tr>
          )}
        </tbody>
      </table>
      {series.isError && <Alert>{t('tax.series.loadFailed')}</Alert>}
      <Note className={settingsClasses.tableNote}>{t('tax.series.note')}</Note>
      {editing && (
        <SeriesDialog series={editing} name={name(editing)} onClose={() => setEditing(null)} />
      )}
    </Card>
  );
}

type SeriesField = 'prefix' | 'numberWidth' | 'startNumber';

/** Prefix, width and start of a series that has not issued a number yet. */
function SeriesDialog(props: { series: SeriesItem; name: string; onClose: () => void }) {
  const { t } = useTranslation('setup');
  const { t: md } = useTranslation('masterdata');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [prefix, setPrefix] = useState(props.series.prefix);
  const [width, setWidth] = useState(String(props.series.numberWidth));
  const [start, setStart] = useState(props.series.startNumber);
  const [problems, setProblems] = useState<Partial<Record<SeriesField, string>>>({});
  const [error, setError] = useState<unknown>(null);
  const save = useSave(
    (api, body: UpdateSeriesRequest, key) =>
      api.patch<SeriesItem>(`/api/v1/settings/series/${props.series.id}`, body, {
        idempotencyKey: key,
      }),
    {
      invalidate: [MD_KEYS.series],
      onSuccess: () => {
        toast(md('saved'));
        props.onClose();
      },
    },
  );

  const cleanPrefix = prefix.trim().toUpperCase();
  const widthValue = Number(asciiDigits(width.trim()));
  const startValue = asciiDigits(start.trim());
  const widthOk = Number.isInteger(widthValue) && widthValue >= 1 && widthValue <= 12;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const found: Partial<Record<SeriesField, string>> = {};
    if (!PREFIX.test(cleanPrefix)) found.prefix = t('tax.series.prefixInvalid');
    if (!widthOk) found.numberWidth = t('tax.series.widthInvalid');
    if (!START.test(startValue)) found.startNumber = t('tax.series.startInvalid');
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    save.mutate(
      {
        prefix: cleanPrefix,
        numberWidth: widthValue,
        startNumber: startValue,
        rowVersion: props.series.rowVersion,
      },
      { onError: setError },
    );
  };

  const canPreview = PREFIX.test(cleanPrefix) && widthOk && START.test(startValue);
  return (
    <Dialog isOpen onClose={props.onClose} title={`${t('tax.series.editTitle')} · ${props.name}`}>
      <form className={settingsClasses.ucard} onSubmit={submit} noValidate>
        <Note>{t('tax.series.editNote')}</Note>
        <TextField
          label={t('tax.series.prefix')}
          value={prefix}
          onChange={setPrefix}
          error={problems.prefix}
          hint={t('tax.series.prefixHint')}
          maxLength={16}
          autoFocus
          ltr
        />
        <div className={settingsClasses.grid2}>
          <TextField
            label={t('tax.series.width')}
            value={width}
            onChange={setWidth}
            error={problems.numberWidth}
            hint={t('tax.series.widthHint')}
            inputMode="numeric"
            maxLength={2}
            ltr
          />
          <TextField
            label={t('tax.series.start')}
            value={start}
            onChange={setStart}
            error={problems.startNumber}
            inputMode="numeric"
            maxLength={18}
            ltr
          />
        </div>
        {canPreview && (
          <p className={styles.preview}>
            {t('tax.series.preview')}{' '}
            <b>
              <bdi>{preview(cleanPrefix, widthValue, startValue)}</bdi>
            </b>
          </p>
        )}
        <SaveProblem
          error={error}
          onReload={() => {
            void queryClient.invalidateQueries({ queryKey: MD_KEYS.series });
            props.onClose();
          }}
        />
        <DialogFooter>
          <Button onPress={props.onClose}>{md('actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending} isDisabled={save.isPending}>
            {md('actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
