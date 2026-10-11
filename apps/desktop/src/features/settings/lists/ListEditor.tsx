/**
 * One editor for the simple lists of Settings → Lists (decision 0034): a table in a card with an
 * Active/Deactivated filter, a "New …" button, an edit dialog, and deactivate (with a reason,
 * nothing is ever deleted — decision 0037) / reactivate. Each list gives its columns and its
 * extra form fields; the code and the two names are common to all of them.
 */
import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Pencil, Plus, Power, PowerOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient, type QueryKey, type UseQueryResult } from '@tanstack/react-query';
import { CODE_PATTERN, normalizeCode } from '@artepool/shared';
import {
  Button,
  Card,
  cx,
  Dialog,
  DialogFooter,
  iconClass,
  tableClasses,
  TextField,
  useToast,
} from '../../../ui';
import { localName } from '../../masterdata/refs';
import { DeactivateDialog } from '../../masterdata/DeactivateDialog';
import { useSave } from '../api';
import { CardHead } from '../parts';
import {
  ActiveFilter,
  listClasses as styles,
  namesField,
  passesFilter,
  SaveError,
  StatusChip,
  useServerFieldError,
  type ActiveFilterValue,
} from './parts';

export interface ListRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  isActive: boolean;
  rowVersion: number;
}

export interface BaseForm {
  code: string;
  nameAr: string;
  nameEn: string;
}

export interface Column<R> {
  id: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  num?: boolean;
}

export interface FieldsContext<R, F> {
  form: F;
  set: (patch: Partial<F>) => void;
  /** The record being edited; null for a new one. */
  editing: R | null;
  /** The message to show under a field (a local check or the server's refusal). */
  error: (field: string) => string | undefined;
}

export interface ListEditorProps<R extends ListRow, F extends BaseForm> {
  /** The tab's key in the `lists` namespace: `<section>.title`, `.new`, `.edit`, `.empty`. */
  section: string;
  basePath: string;
  queryKey: QueryKey;
  query: UseQueryResult<R[]>;
  canEdit: boolean;
  /** The code never changes after creation (units, warehouses, payment methods, …). */
  codeFixed: boolean;
  columns: Column<R>[];
  toForm: (row: R | null) => F;
  /** The body without the code and the row version (the editor adds them). */
  toBody: (form: F, editing: R | null) => Record<string, unknown>;
  /** Local checks of the extra fields: field → translated message. */
  check?: (form: F) => Record<string, string>;
  fields?: (ctx: FieldsContext<R, F>) => ReactNode;
  /** Server field names the extra fields show messages for. */
  fieldNames?: readonly string[];
  /** Rows in display order with their depth (a tree); default: as the server sends them. */
  order?: (rows: R[]) => { row: R; depth: number }[];
  canDeactivate?: (row: R) => boolean;
  rowTools?: (row: R) => ReactNode;
  /** Shown under the table. */
  note?: ReactNode;
  /** More queries a save changes (e.g. the chart's "in use" marks). */
  invalidate?: QueryKey[];
}

export function ListEditor<R extends ListRow, F extends BaseForm>(props: ListEditorProps<R, F>) {
  const { t, i18n } = useTranslation('lists');
  const toast = useToast();
  const queryClient = useQueryClient();
  const nameOf = localName(i18n.language);
  const [filter, setFilter] = useState<ActiveFilterValue>('active');
  const [editing, setEditing] = useState<R | 'new' | null>(null);
  const [deactivating, setDeactivating] = useState<R | null>(null);
  const [rowError, setRowError] = useState<unknown>(null);
  const invalidate = [props.queryKey, ...(props.invalidate ?? [])];

  const reactivate = useSave(
    (api, row: R, key) =>
      api.post(
        `${props.basePath}/${row.id}/reactivate`,
        { rowVersion: row.rowVersion },
        { idempotencyKey: key },
      ),
    { invalidate, onSuccess: () => toast(t('masterdata:reactivated')) },
  );
  const deactivate = useSave(
    (api, input: { row: R; reason: string }, key) =>
      api.post(
        `${props.basePath}/${input.row.id}/deactivate`,
        { reason: input.reason, rowVersion: input.row.rowVersion },
        { idempotencyKey: key },
      ),
    {
      invalidate,
      onSuccess: () => {
        toast(t('masterdata:deactivated'));
        setDeactivating(null);
      },
    },
  );

  const rows = props.query.data ?? [];
  const ordered = (props.order ? props.order(rows) : rows.map((row) => ({ row, depth: 0 }))).filter(
    ({ row }) => passesFilter(filter, row.isActive),
  );
  const columnCount = props.columns.length + 4;

  return (
    <Card rise index={2} padding="table">
      <div className={styles.tableHead}>
        <CardHead title={t(`${props.section}.title`)}>
          <div className={styles.headTools}>
            <ActiveFilter value={filter} onChange={setFilter} />
            {props.canEdit && (
              <Button variant="primary" onPress={() => setEditing('new')}>
                <Plus className={iconClass.sm} aria-hidden="true" />
                {t(`${props.section}.new`)}
              </Button>
            )}
          </div>
        </CardHead>
        <SaveError
          error={rowError}
          onReload={() => {
            setRowError(null);
            void queryClient.invalidateQueries({ queryKey: props.queryKey });
          }}
        />
      </div>
      <table className={tableClasses.table}>
        <thead>
          <tr>
            <th>{t('col.code')}</th>
            <th>{t('col.name')}</th>
            {props.columns.map((column) => (
              <th key={column.id} className={cx(column.num && tableClasses.num)}>
                {column.header}
              </th>
            ))}
            <th>{t('col.status')}</th>
            <th>
              <span className={styles.visuallyHidden}>{t('col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(({ row, depth }) => (
            <tr key={row.id} className={cx(!row.isActive && tableClasses.off)}>
              <td>
                <b>
                  <bdi>{row.code}</bdi>
                </b>
              </td>
              <td>
                <span className={styles.treeName} style={{ '--depth': depth } as CSSProperties}>
                  <span>{nameOf(row)}</span>
                  <span className={tableClasses.sub}>
                    <bdi>{i18n.language === 'en' ? row.nameAr : row.nameEn}</bdi>
                  </span>
                </span>
              </td>
              {props.columns.map((column) => (
                <td key={column.id} className={cx(column.num && tableClasses.num)}>
                  {column.cell(row)}
                </td>
              ))}
              <td>
                <StatusChip active={row.isActive} />
              </td>
              <td className={tableClasses.num}>
                {props.canEdit && (
                  <span className={styles.rowTools}>
                    {row.isActive && props.rowTools?.(row)}
                    {row.isActive && (
                      <Button
                        variant="ghost"
                        aria-label={t('editOne', { code: row.code })}
                        onPress={() => setEditing(row)}
                      >
                        <Pencil className={iconClass.sm} aria-hidden="true" />
                      </Button>
                    )}
                    {row.isActive && (props.canDeactivate?.(row) ?? true) && (
                      <Button
                        variant="dangerGhost"
                        aria-label={t('deactivateOne', { code: row.code })}
                        onPress={() => {
                          deactivate.reset();
                          setDeactivating(row);
                        }}
                      >
                        <PowerOff className={iconClass.sm} aria-hidden="true" />
                      </Button>
                    )}
                    {!row.isActive && (
                      <Button
                        variant="ghost"
                        busy={reactivate.isPending && reactivate.variables?.id === row.id}
                        onPress={() => {
                          setRowError(null);
                          reactivate.mutate(row, { onError: setRowError });
                        }}
                      >
                        <Power className={iconClass.sm} aria-hidden="true" />
                        {t('masterdata:actions.reactivate')}
                      </Button>
                    )}
                  </span>
                )}
              </td>
            </tr>
          ))}
          {ordered.length === 0 && (
            <tr className={tableClasses.empty}>
              <td colSpan={columnCount}>
                {props.query.isLoading ? t('loading') : t(`${props.section}.empty`)}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {props.query.isError && (
        <div className={styles.tableNote}>
          <SaveError error={props.query.error} />
        </div>
      )}
      {props.note && <div className={styles.tableNote}>{props.note}</div>}
      {editing && (
        <EditDialog
          {...props}
          editing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deactivating && (
        <DeactivateDialog
          title={t('deactivateTitle')}
          subject={
            <b>
              <bdi>{deactivating.code}</bdi> · {nameOf(deactivating)}
            </b>
          }
          busy={deactivate.isPending}
          error={deactivate.error}
          onConfirm={(reason) => deactivate.mutate({ row: deactivating, reason })}
          onClose={() => setDeactivating(null)}
        />
      )}
    </Card>
  );
}

function EditDialog<R extends ListRow, F extends BaseForm>(
  props: ListEditorProps<R, F> & { editing: R | null; onClose: () => void },
) {
  const { t } = useTranslation('lists');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<R | null>(props.editing);
  const [form, setForm] = useState<F>(() => props.toForm(props.editing));
  const [local, setLocal] = useState<Record<string, string>>({});
  const save = useSave(
    (api, body: Record<string, unknown>, key) =>
      editing
        ? api.patch(`${props.basePath}/${editing.id}`, body, { idempotencyKey: key })
        : api.post(props.basePath, body, { idempotencyKey: key }),
    {
      invalidate: [props.queryKey, ...(props.invalidate ?? [])],
      onSuccess: () => {
        toast(t('masterdata:saved'));
        props.onClose();
      },
    },
  );
  const serverError = useServerFieldError(save.error);
  const error = (field: string) => local[field] ?? serverError(field);
  const set = (patch: Partial<F>) => setForm((old) => ({ ...old, ...patch }));
  const codeLocked = editing !== null && props.codeFixed;

  const reload = async () => {
    await queryClient.refetchQueries({ queryKey: props.queryKey });
    const fresh = (queryClient.getQueryData<R[]>(props.queryKey) ?? []).find(
      (row) => row.id === editing?.id,
    );
    save.reset();
    if (fresh) {
      setEditing(fresh);
      setForm(props.toForm(fresh));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const problems: Record<string, string> = { ...(props.check?.(form) ?? {}) };
    const code = normalizeCode(form.code);
    if (!codeLocked && !CODE_PATTERN.test(code)) problems.code = t('codeRule');
    if (!form.nameAr.trim()) problems.nameAr = t('masterdata:fields.required');
    if (!form.nameEn.trim()) problems.nameEn = t('masterdata:fields.required');
    setLocal(problems);
    if (Object.keys(problems).length > 0) return;
    const body: Record<string, unknown> = {
      ...props.toBody({ ...form, nameAr: form.nameAr.trim(), nameEn: form.nameEn.trim() }, editing),
      nameAr: form.nameAr.trim(),
      nameEn: form.nameEn.trim(),
    };
    if (!codeLocked) body.code = code;
    if (editing) body.rowVersion = editing.rowVersion;
    save.mutate(body);
  };

  const fieldNames = ['code', 'nameAr', 'nameEn', ...(props.fieldNames ?? [])];
  return (
    <Dialog
      isOpen
      onClose={props.onClose}
      wide
      title={editing ? t(`${props.section}.edit`) : t(`${props.section}.new`)}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        {save.error !== null && !namesField(save.error, fieldNames) && (
          <SaveError error={save.error} onReload={() => void reload()} />
        )}
        <div className={styles.grid3}>
          <TextField
            label={t('field.code')}
            value={form.code}
            onChange={(code) => set({ code } as Partial<F>)}
            ltr
            maxLength={32}
            isRequired={!codeLocked}
            isDisabled={codeLocked}
            autoFocus={!codeLocked}
            hint={codeLocked ? t('codeFixed') : undefined}
            error={error('code')}
          />
          <TextField
            label={t('field.nameAr')}
            value={form.nameAr}
            onChange={(nameAr) => set({ nameAr } as Partial<F>)}
            isRequired
            maxLength={200}
            autoFocus={codeLocked}
            error={error('nameAr')}
          />
          <TextField
            label={t('field.nameEn')}
            value={form.nameEn}
            onChange={(nameEn) => set({ nameEn } as Partial<F>)}
            isRequired
            ltr
            maxLength={200}
            error={error('nameEn')}
          />
        </div>
        {props.fields?.({ form, set, editing, error })}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('masterdata:actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {t('masterdata:actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
