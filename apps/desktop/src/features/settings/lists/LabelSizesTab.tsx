/**
 * Settings → Lists → Label sizes (decisions 0043, 0096): the barcode label sizes offered when
 * printing labels, in whole millimetres, never wider than the label printer's roll. Everyone who
 * opens Lists sees them; only the owner (`system.settings.edit`) adds, changes or deactivates one.
 * The code never changes.
 */
import { useTranslation } from 'react-i18next';
import type { LabelSizeItem } from '@artepool/shared/contracts';
import { Note, TextField } from '../../../ui';
import { useCan } from '../../auth/context';
import { MD_KEYS, useLabelMaxWidth, useLabelSizes } from '../../masterdata/refs';
import { ListEditor } from './ListEditor';
import { listClasses as styles, parseWhole } from './parts';

/** The limits the server accepts: the height up to an A4 sheet; the width up to the label roll. */
export const LABEL_LIMITS = {
  width: { min: 10, max: 210 },
  height: { min: 10, max: 297 },
} as const;

/** The width limits for this shop: never wider than the label printer's roll (decision 0096). */
const widthLimits = (maxWidthMm: number | undefined) => ({
  min: LABEL_LIMITS.width.min,
  max: Math.min(LABEL_LIMITS.width.max, maxWidthMm ?? LABEL_LIMITS.width.max),
});

type LabelSizeForm = {
  code: string;
  nameAr: string;
  nameEn: string;
  widthMm: string;
  heightMm: string;
  sortOrder: string;
};

/** A whole number of millimetres within the limits, or null. */
export function parseMm(text: string, limits: { min: number; max: number }): number | null {
  const value = parseWhole(text, limits.max);
  return value !== null && value >= limits.min ? value : null;
}

export function LabelSizesTab() {
  const { t } = useTranslation('lists');
  const can = useCan();
  const sizes = useLabelSizes();
  const width = widthLimits(useLabelMaxWidth().data);
  return (
    <ListEditor<LabelSizeItem, LabelSizeForm>
      section="labelSizes"
      basePath="/api/v1/label-sizes"
      queryKey={MD_KEYS.labelSizes}
      query={sizes}
      canEdit={can('system.settings.edit')}
      codeFixed
      columns={[
        {
          id: 'size',
          header: t('labelSizes.size'),
          num: true,
          cell: (s) => (
            <bdi>{t('labelSizes.sizeValue', { width: s.widthMm, height: s.heightMm })}</bdi>
          ),
        },
        {
          id: 'sort',
          header: t('field.sortOrder'),
          num: true,
          cell: (s) => <bdi>{s.sortOrder}</bdi>,
        },
      ]}
      toForm={(s) => ({
        code: s?.code ?? '',
        nameAr: s?.nameAr ?? '',
        nameEn: s?.nameEn ?? '',
        widthMm: s ? String(s.widthMm) : '',
        heightMm: s ? String(s.heightMm) : '',
        sortOrder: String(s?.sortOrder ?? 0),
      })}
      toBody={(form) => ({
        widthMm: parseMm(form.widthMm, width),
        heightMm: parseMm(form.heightMm, LABEL_LIMITS.height),
        sortOrder: parseWhole(form.sortOrder, 999) ?? 0,
      })}
      check={(form) => {
        const problems: Record<string, string> = {};
        if (parseMm(form.widthMm, width) === null) problems.widthMm = t('labelSizes.mmRule', width);
        if (parseMm(form.heightMm, LABEL_LIMITS.height) === null)
          problems.heightMm = t('labelSizes.mmRule', LABEL_LIMITS.height);
        if (parseWhole(form.sortOrder, 999) === null) problems.sortOrder = t('sortOrderRule');
        return problems;
      }}
      fieldNames={['widthMm', 'heightMm', 'sortOrder']}
      fields={({ form, set, error }) => (
        <div className={styles.grid3}>
          <TextField
            label={t('labelSizes.width')}
            value={form.widthMm}
            onChange={(widthMm) => set({ widthMm })}
            ltr
            inputMode="numeric"
            maxLength={3}
            isRequired
            hint={t('labelSizes.widthHint', width)}
            error={error('widthMm')}
          />
          <TextField
            label={t('labelSizes.height')}
            value={form.heightMm}
            onChange={(heightMm) => set({ heightMm })}
            ltr
            inputMode="numeric"
            maxLength={3}
            isRequired
            hint={t('labelSizes.mmHint', LABEL_LIMITS.height)}
            error={error('heightMm')}
          />
          <TextField
            label={t('field.sortOrder')}
            value={form.sortOrder}
            onChange={(sortOrder) => set({ sortOrder })}
            ltr
            inputMode="numeric"
            maxLength={3}
            hint={t('sortOrderHint')}
            error={error('sortOrder')}
          />
        </div>
      )}
      note={<Note>{t('labelSizes.note')}</Note>}
    />
  );
}
