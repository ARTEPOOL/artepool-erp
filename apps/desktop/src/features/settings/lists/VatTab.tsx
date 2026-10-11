/**
 * Settings → Lists → VAT categories (decision 0033): the four UAE categories, shown to everyone
 * who opens Lists. Only the owner changes a rate, only the standard rate can be above 0%, with a
 * written reason; the change applies to new documents only and is written to the audit log.
 */
import { useState, type FormEvent } from 'react';
import { Lock, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { VatCategoryItem } from '@artepool/shared/contracts';
import {
  Button,
  Card,
  Dialog,
  DialogFooter,
  iconClass,
  InfoBar,
  Note,
  tableClasses,
  TextField,
  useToast,
} from '../../../ui';
import { useCan } from '../../auth/context';
import { rate } from '../../masterdata/format';
import { localName, MD_KEYS, useVat } from '../../masterdata/refs';
import { useSave } from '../api';
import { CardHead } from '../parts';
import { listClasses as styles, parsePercent, percentText, SaveError } from './parts';

/** Exempt and out-of-scope supplies carry no VAT at all: shown as "—", not 0%. */
const NO_RATE = new Set(['EX', 'OS']);

export function VatTab() {
  const { t, i18n } = useTranslation('lists');
  const can = useCan();
  const vat = useVat();
  const nameOf = localName(i18n.language);
  const [editing, setEditing] = useState<VatCategoryItem | null>(null);
  const isOwner = can('system.settings.edit');
  const categories = vat.data?.categories ?? [];

  return (
    <Card rise index={2} padding="table">
      <div className={styles.tableHead}>
        <CardHead title={t('vat.title')} />
      </div>
      <table className={tableClasses.table}>
        <thead>
          <tr>
            <th>{t('col.code')}</th>
            <th>{t('vat.category')}</th>
            <th className={tableClasses.num}>{t('vat.rate')}</th>
            <th>
              <span className={styles.visuallyHidden}>{t('col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <tr key={category.id}>
              <td>
                <b>
                  <bdi>{category.code}</bdi>
                </b>
              </td>
              <td>
                <span className={styles.treeName}>
                  <span>{nameOf(category)}</span>
                  <span className={tableClasses.sub}>{t(`vat.meaning.${category.code}`)}</span>
                </span>
              </td>
              <td className={tableClasses.num}>
                <b>
                  <bdi>
                    {NO_RATE.has(category.code) ? t('masterdata:none') : rate(category.rateBp)}
                  </bdi>
                </b>
              </td>
              <td className={tableClasses.num}>
                {isOwner && category.code === 'SR' ? (
                  <Button
                    variant="ghost"
                    aria-label={t('vat.changeRateOf', { code: category.code })}
                    onPress={() => setEditing(category)}
                  >
                    <Pencil className={iconClass.sm} aria-hidden="true" />
                    {t('vat.changeRate')}
                  </Button>
                ) : (
                  <Lock className={iconClass.sm} role="img" aria-label={t('vat.fixed')} />
                )}
              </td>
            </tr>
          ))}
          {categories.length === 0 && (
            <tr className={tableClasses.empty}>
              <td colSpan={4}>{vat.isLoading ? t('loading') : t('vat.empty')}</td>
            </tr>
          )}
        </tbody>
      </table>
      {vat.isError && <SaveError error={vat.error} />}
      <div className={styles.tableNote}>
        <Note>{isOwner ? t('vat.noteOwner') : t('vat.noteOthers')}</Note>
      </div>
      {editing && <RateDialog category={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function RateDialog(props: { category: VatCategoryItem; onClose: () => void }) {
  const { t, i18n } = useTranslation('lists');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState(props.category);
  const [rateText, setRateText] = useState(percentText(props.category.rateBp));
  const [reason, setReason] = useState('');
  const [problems, setProblems] = useState<{ rate?: string; reason?: string }>({});
  const save = useSave(
    (api, body: { rateBp: number; reason: string; rowVersion: number }, key) =>
      api.patch(`/api/v1/settings/vat/${category.id}`, body, { idempotencyKey: key }),
    {
      invalidate: [MD_KEYS.vat],
      onSuccess: () => {
        toast(t('vat.saved'));
        props.onClose();
      },
    },
  );

  const reload = async () => {
    await queryClient.refetchQueries({ queryKey: MD_KEYS.vat });
    const fresh = queryClient
      .getQueryData<{ categories: VatCategoryItem[] }>(MD_KEYS.vat)
      ?.categories.find((c) => c.id === category.id);
    save.reset();
    if (fresh) {
      setCategory(fresh);
      setRateText(percentText(fresh.rateBp));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const rateBp = parsePercent(rateText);
    const found: { rate?: string; reason?: string } = {};
    if (rateBp === null || rateBp === 0) found.rate = t('vat.rateRule');
    if (reason.trim().length < 3) found.reason = t('masterdata:deactivate.reasonTooShort');
    setProblems(found);
    if (rateBp === null || found.rate || found.reason) return;
    save.mutate({ rateBp, reason: reason.trim(), rowVersion: category.rowVersion });
  };

  return (
    <Dialog
      isOpen
      onClose={props.onClose}
      title={t('vat.dialogTitle', { name: localName(i18n.language)(category) })}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <InfoBar>{t('vat.dialogNote')}</InfoBar>
        <SaveError error={save.error} onReload={() => void reload()} />
        <p>
          {t('vat.current')} <bdi>{rate(category.rateBp)}</bdi>
        </p>
        <TextField
          label={t('vat.newRate')}
          value={rateText}
          onChange={setRateText}
          ltr
          inputMode="numeric"
          maxLength={6}
          autoFocus
          isRequired
          hint={t('vat.rateHint')}
          error={problems.rate}
        />
        <TextField
          label={t('masterdata:deactivate.reason')}
          value={reason}
          onChange={setReason}
          multiline
          isRequired
          placeholder={t('masterdata:deactivate.reasonHint')}
          error={problems.reason}
        />
        <DialogFooter>
          <Button onPress={props.onClose}>{t('masterdata:actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            {t('vat.save')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
