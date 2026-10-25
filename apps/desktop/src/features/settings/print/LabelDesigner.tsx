/**
 * Settings → Print designer → Barcode label (decision 0097). The owner decides what the label shows
 * and how: each element shown or hidden, its order, size, bold and alignment; the barcode's height
 * (never below 5 mm: the label must always scan); the language of the fixed words; "incl. VAT";
 * a free text line; margins and a border; and, for any size, what that size does differently. The
 * previews show a real item on every active size, exactly as it would print; a size the design does
 * not fit says so. Every save is a new version.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUp, Printer, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_LABEL_PRINTER,
  defaultLabelDesign,
  LABEL_ALIGNS,
  LABEL_BARCODE_MAX_HEIGHT_MM,
  LABEL_BARCODE_MIN_HEIGHT_MM,
  LABEL_BILINGUAL_ELEMENTS,
  LABEL_LANGUAGES,
  LABEL_SIZES,
  LabelDesign,
  type ItemDetail,
  type ItemsResponse,
  type LabelDesignResponse,
  type LabelElement,
  type LabelLanguage,
  type LabelSizeOverride,
  type SaveLabelDesignRequest,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { dubaiDay, formatDateTime } from '../../../lib/format';
import {
  Alert,
  Button,
  Card,
  Chip,
  iconClass,
  Note,
  Segmented,
  SelectField,
  Switch,
  TextField,
  useToast,
} from '../../../ui';
import { useDisplayName } from '../../auth/context';
import {
  drawLabel,
  LABEL_DESIGN_KEY,
  labelContent,
  useLabelDesign,
} from '../../items/labels/design';
import { canPrintLabelsSilently, printLabels, useLabelPrinter } from '../../items/labels/printer';
import { canvasMeasurer, printedDotsUrl } from '../../items/labels/render';
import { labelWords } from '../../items/labels/words';
import { localName, useLabelSizes, useUnits, useVat } from '../../masterdata/refs';
import { SaveProblem } from '../company/SaveProblem';
import { CardHead } from '../parts';
import styles from './print.module.css';

/** An item to show in the previews when none is chosen (a long name, a price with VAT). */
const SAMPLE: Pick<
  ItemDetail,
  'nameAr' | 'nameEn' | 'code' | 'primaryBarcode' | 'price' | 'packAr' | 'packEn' | 'unitId'
> = {
  nameAr: 'كلور أقراص 90% سريع الذوبان للمسابح',
  nameEn: 'Chlorine tablets 90% fast dissolving',
  code: 'CHEM-0013',
  primaryBarcode: '6291041500213',
  price: { price4dp: '1200000', includesVat: true },
  packAr: 'دلو 5 كجم',
  packEn: '5 kg bucket',
  unitId: '',
};

/** Whether an element can be printed in Arabic, English or both (decision 0101). */
const bilingual = (element: LabelElement) =>
  (LABEL_BILINGUAL_ELEMENTS as readonly LabelElement[]).includes(element);

/** Half millimetres from the field, or null. */
const halfMm = (text: string): number | null => {
  const v = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(v) && Math.abs(v * 2 - Math.round(v * 2)) < 1e-9
    ? v
    : null;
};

export function LabelDesigner() {
  const query = useLabelDesign();
  if (!query.data) return null;
  return <Editor key={query.data.versionId} saved={query.data} />;
}

function Editor({ saved }: { saved: LabelDesignResponse }) {
  const { t, i18n } = useTranslation('settings');
  const api = useApi();
  const toast = useToast();
  const nameOf = useDisplayName();
  const queryClient = useQueryClient();
  const name = localName(i18n.language);
  const [design, setDesign] = useState<LabelDesign>(saved.design);
  const [heightText, setHeightText] = useState(String(saved.design.barcode.heightMm));
  const [overrideSize, setOverrideSize] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [itemId, setItemId] = useState('');
  const [testSizeId, setTestSizeId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const changed = JSON.stringify(design) !== JSON.stringify(saved.design);
  const valid = LabelDesign.safeParse(design).success;
  const sizes = (useLabelSizes().data ?? [])
    .filter((s) => s.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const printer = useLabelPrinter().data ?? DEFAULT_LABEL_PRINTER;
  const units = useUnits().data ?? [];
  const rates = new Map((useVat().data?.categories ?? []).map((c) => [c.id, c.rateBp]));

  // A real item for the previews: chosen from a search, else the sample.
  const found = useQuery({
    queryKey: ['label-designer-items', itemSearch],
    queryFn: () =>
      api.get<ItemsResponse>(`/api/v1/items?limit=20&q=${encodeURIComponent(itemSearch.trim())}`),
  });
  const item = useQuery({
    queryKey: ['label-designer-item', itemId],
    queryFn: () => api.get<ItemDetail>(`/api/v1/items/${itemId}`),
    enabled: itemId !== '',
  });
  const shown = item.data ?? SAMPLE;
  const rateBp = item.data ? rates.get(item.data.vatCategoryId) : 500;

  const measurer = useMemo(() => canvasMeasurer(), []);
  const words = useMemo(() => labelWords(i18n), [i18n]);
  const previews = useMemo(
    () =>
      sizes.map((size) => {
        const draw = (extras: { expiry: string; batch: string }) =>
          drawLabel({
            size,
            printer,
            design,
            content: labelContent(shown, {
              design,
              shopName: saved.shopName,
              units,
              rateBp,
              withPrice: true,
              extras,
              today: dubaiDay(),
            }),
            words,
            measurer,
          });
        // With an expiry date and a batch number typed, as on a pool chemical; when only those
        // two make it too much for this size, the label without them is shown, with a warning.
        const full = draw({ expiry: '2027-05-31', batch: 'A1234' });
        const plain = full.layout.ok ? full : draw({ expiry: '', batch: '' });
        const drawn = plain.layout.ok ? plain : full;
        const extrasWontFit = !full.layout.ok && plain.layout.ok;
        return {
          size,
          ...drawn,
          extrasWontFit,
          url: drawn.image ? printedDotsUrl(drawn.image) : '',
        };
      }),
    [sizes, shown, design, saved.shopName, units, rateBp, printer, words, measurer],
  );

  const save = useSave(
    (client, body: SaveLabelDesignRequest, key) =>
      client.post<LabelDesignResponse>('/api/v1/label-design/versions', body, {
        idempotencyKey: key,
      }),
    {
      invalidate: [LABEL_DESIGN_KEY],
      onSuccess: (result) => toast(t('labelDesign.saved', { version: result.versionNo })),
    },
  );

  const setElement = (
    element: LabelElement,
    patch: Partial<LabelDesign['elements'][LabelElement]>,
  ) =>
    setDesign((d) => ({
      ...d,
      elements: { ...d.elements, [element]: { ...d.elements[element], ...patch } },
    }));
  const move = (index: number, by: -1 | 1) =>
    setDesign((d) => {
      const order = [...d.order];
      const [moved] = order.splice(index, 1);
      order.splice(index + by, 0, moved!);
      return { ...d, order };
    });
  const setOverride = (code: string, override: LabelSizeOverride | null) =>
    setDesign((d) => {
      const overrides = { ...d.overrides };
      if (override) overrides[code] = override;
      else delete overrides[code];
      return { ...d, overrides };
    });

  const testSize = sizes.find((s) => s.id === testSizeId) ?? sizes[0];
  const testPreview = previews.find((p) => p.size.id === testSize?.id);
  const printTest = async () => {
    if (!testSize || !testPreview?.image) return;
    const outcome = await printLabels(testPreview.image, testSize, printer, 1, 'label-design-test');
    setProblem(outcome.printed ? null : t(`devices.labelProblem.${outcome.reason}`));
    if (outcome.printed) toast(t('devices.testSent'));
  };

  const override = overrideSize ? (design.overrides[overrideSize] ?? { elements: {} }) : null;
  const elementName = (e: LabelElement) => t(`labelDesign.elements.${e}`);

  return (
    <div className={styles.layout}>
      <div className={styles.controls}>
        <Card rise index={1} className={styles.card}>
          <div className={styles.version}>
            <span>
              {t('print.version', { version: saved.versionNo })} ·{' '}
              <bdi>{formatDateTime(saved.savedAt)}</bdi>
              {saved.savedBy && <> · {nameOf(saved.savedBy)}</>}
            </span>
            {changed && <Chip tone="warn">{t('print.unsaved')}</Chip>}
          </div>
          <div className={styles.buttons}>
            <Button
              onPress={() => {
                setDesign(defaultLabelDesign());
                setHeightText(String(defaultLabelDesign().barcode.heightMm));
              }}
            >
              <RotateCcw className={iconClass.sm} aria-hidden="true" />
              {t('labelDesign.reset')}
            </Button>
            <Button
              isDisabled={!testPreview?.image || !canPrintLabelsSilently(printer)}
              onPress={() => void printTest()}
            >
              <Printer className={iconClass.sm} aria-hidden="true" />
              {t('devices.labelTestPrint')}
            </Button>
            <Button
              variant="primary"
              isDisabled={!changed || !valid || !saved.canEdit}
              busy={save.isPending}
              onPress={() => save.mutate({ design, basedOnVersionId: saved.versionId })}
            >
              <Save className={iconClass.sm} aria-hidden="true" />
              {t('print.save')}
            </Button>
          </div>
          {sizes.length > 0 && (
            <SelectField
              id="label-test-size"
              label={t('devices.labelTestSize')}
              value={testSize?.id ?? ''}
              onChange={setTestSizeId}
              options={sizes.map((s) => ({
                value: s.id,
                label: `${name(s)} (${s.widthMm} × ${s.heightMm})`,
              }))}
            />
          )}
          {problem && <Alert tone="warn">{problem}</Alert>}
          <SaveProblem
            error={save.error}
            onReload={() => void queryClient.invalidateQueries({ queryKey: LABEL_DESIGN_KEY })}
          />
        </Card>

        <Card rise index={2} className={styles.card}>
          <CardHead title={t('labelDesign.elementsTitle')} />
          <p className={styles.why}>{t('labelDesign.elementsHelp')}</p>
          <ol className={styles.elementList}>
            {design.order.map((element, index) => {
              const s = design.elements[element];
              const always = element === 'barcode';
              return (
                <li
                  key={element}
                  className={styles.elementRow}
                  data-testid={`label-element-${element}`}
                >
                  <div className={styles.elementHead}>
                    <Switch
                      isSelected={always || s.show}
                      isDisabled={always}
                      onChange={(show) => setElement(element, { show })}
                    >
                      {elementName(element)}
                    </Switch>
                    <span className={styles.elementMove}>
                      <Button
                        variant="ghost"
                        isDisabled={index === 0}
                        aria-label={t('labelDesign.moveUp', { element: elementName(element) })}
                        onPress={() => move(index, -1)}
                      >
                        <ArrowUp className={iconClass.sm} aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        isDisabled={index === design.order.length - 1}
                        aria-label={t('labelDesign.moveDown', { element: elementName(element) })}
                        onPress={() => move(index, 1)}
                      >
                        <ArrowDown className={iconClass.sm} aria-hidden="true" />
                      </Button>
                    </span>
                  </div>
                  {(always || s.show) && (
                    <div className={styles.elementStyle}>
                      <Segmented
                        label={t('labelDesign.size', { element: elementName(element) })}
                        value={s.size}
                        onChange={(size) => setElement(element, { size })}
                        options={LABEL_SIZES.map((v) => ({
                          value: v,
                          label: t(`labelDesign.sizes.${v}`),
                        }))}
                      />
                      <Segmented
                        label={t('labelDesign.align', { element: elementName(element) })}
                        value={s.align}
                        onChange={(align) => setElement(element, { align })}
                        options={LABEL_ALIGNS.map((v) => ({
                          value: v,
                          label: t(`labelDesign.aligns.${v}`),
                        }))}
                      />
                      {bilingual(element) && (
                        <Segmented
                          label={t('labelDesign.lang', { element: elementName(element) })}
                          value={s.lang ?? 'design'}
                          onChange={(lang) =>
                            setElement(element, { lang: lang === 'design' ? undefined : lang })
                          }
                          options={(['design', ...LABEL_LANGUAGES] as const).map((v) => ({
                            value: v,
                            label: t(`labelDesign.langs.${v}`),
                          }))}
                        />
                      )}
                      {!always && (
                        <Switch
                          isSelected={s.bold}
                          onChange={(bold) => setElement(element, { bold })}
                        >
                          {t('labelDesign.bold')}
                        </Switch>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </Card>

        <Card rise index={3} className={styles.card}>
          <CardHead title={t('labelDesign.barcodeTitle')} />
          <TextField
            label={t('labelDesign.barcodeHeight')}
            value={heightText}
            onChange={(text) => {
              setHeightText(text);
              const v = halfMm(text);
              if (v !== null) setDesign((d) => ({ ...d, barcode: { ...d.barcode, heightMm: v } }));
            }}
            ltr
            inputMode="decimal"
            maxLength={4}
            hint={t('labelDesign.barcodeHeightHint', {
              min: LABEL_BARCODE_MIN_HEIGHT_MM,
              max: LABEL_BARCODE_MAX_HEIGHT_MM,
            })}
            error={
              (halfMm(heightText) ?? 0) < LABEL_BARCODE_MIN_HEIGHT_MM ||
              (halfMm(heightText) ?? 99) > LABEL_BARCODE_MAX_HEIGHT_MM
                ? t('labelDesign.barcodeHeightRule', {
                    min: LABEL_BARCODE_MIN_HEIGHT_MM,
                    max: LABEL_BARCODE_MAX_HEIGHT_MM,
                  })
                : undefined
            }
          />
          <Switch
            isSelected={design.barcode.showDigits}
            onChange={(showDigits) =>
              setDesign((d) => ({ ...d, barcode: { ...d.barcode, showDigits } }))
            }
          >
            {t('labelDesign.showDigits')}
          </Switch>
          <Segmented
            label={t('labelDesign.symbology')}
            value={design.barcode.symbology}
            onChange={(symbology) =>
              setDesign((d) => ({ ...d, barcode: { ...d.barcode, symbology } }))
            }
            options={[
              { value: 'auto', label: t('labelDesign.symbologies.auto') },
              { value: 'code128', label: t('labelDesign.symbologies.code128') },
            ]}
          />
          <Note>{t('labelDesign.minimumNote')}</Note>
        </Card>

        <Card rise index={4} className={styles.card}>
          <CardHead title={t('labelDesign.wordsTitle')} />
          <Segmented
            label={t('labelDesign.language')}
            value={design.language}
            onChange={(language) => setDesign((d) => ({ ...d, language }))}
            options={LABEL_LANGUAGES.map((v) => ({
              value: v,
              label: t(`labelDesign.languages.${v}`),
            }))}
          />
          <Segmented
            label={t('labelDesign.vatNote')}
            value={design.vatNote}
            onChange={(vatNote) => setDesign((d) => ({ ...d, vatNote }))}
            options={(['always', 'whenIncluded', 'never'] as const).map((v) => ({
              value: v,
              label: t(`labelDesign.vatNotes.${v}`),
            }))}
          />
          <TextField
            label={t('labelDesign.customText')}
            value={design.customText}
            onChange={(customText) => setDesign((d) => ({ ...d, customText }))}
            maxLength={60}
            hint={t('labelDesign.customTextHint')}
          />
          <div className={styles.texts}>
            <TextField
              label={t('labelDesign.marginSide')}
              value={String(design.marginsMm.side)}
              onChange={(text) => {
                const v = halfMm(text);
                if (v !== null && v >= 0.5 && v <= 4)
                  setDesign((d) => ({ ...d, marginsMm: { ...d.marginsMm, side: v } }));
              }}
              ltr
              inputMode="decimal"
              maxLength={3}
            />
            <TextField
              label={t('labelDesign.marginEdge')}
              value={String(design.marginsMm.edge)}
              onChange={(text) => {
                const v = halfMm(text);
                if (v !== null && v >= 0.5 && v <= 4)
                  setDesign((d) => ({ ...d, marginsMm: { ...d.marginsMm, edge: v } }));
              }}
              ltr
              inputMode="decimal"
              maxLength={3}
            />
          </div>
          <Switch
            isSelected={design.border}
            onChange={(border) => setDesign((d) => ({ ...d, border }))}
          >
            {t('labelDesign.border')}
          </Switch>
        </Card>

        <Card rise index={5} className={styles.card}>
          <CardHead title={t('labelDesign.overridesTitle')} />
          <p className={styles.why}>{t('labelDesign.overridesHelp')}</p>
          <SelectField
            id="label-override-size"
            label={t('labelDesign.overrideSize')}
            value={overrideSize}
            onChange={setOverrideSize}
            options={[
              { value: '', label: t('labelDesign.overrideNone') },
              ...sizes.map((s) => ({
                value: s.code,
                label: `${name(s)} (${s.widthMm} × ${s.heightMm})${design.overrides[s.code] ? ' ●' : ''}`,
              })),
            ]}
          />
          {override && (
            <>
              <ul className={styles.overrideList}>
                {design.order
                  .filter((e) => e !== 'barcode')
                  .map((element) => {
                    const change = override.elements[element] ?? {};
                    const showValue =
                      change.show === undefined ? 'base' : change.show ? 'show' : 'hide';
                    return (
                      <li key={element}>
                        <span>{elementName(element)}</span>
                        <select
                          aria-label={t('labelDesign.overrideShow', {
                            element: elementName(element),
                          })}
                          value={showValue}
                          onChange={(event) => {
                            const value = event.target.value;
                            const next = {
                              ...change,
                              show: value === 'base' ? undefined : value === 'show',
                            };
                            setOverride(overrideSize, {
                              ...override,
                              elements: { ...override.elements, [element]: next },
                            });
                          }}
                        >
                          <option value="base">{t('labelDesign.asBase')}</option>
                          <option value="show">{t('labelDesign.overrideShowOn')}</option>
                          <option value="hide">{t('labelDesign.overrideShowOff')}</option>
                        </select>
                        <select
                          aria-label={t('labelDesign.overrideSizeOf', {
                            element: elementName(element),
                          })}
                          value={change.size ?? 'base'}
                          onChange={(event) => {
                            const value = event.target.value;
                            const next = {
                              ...change,
                              size:
                                value === 'base'
                                  ? undefined
                                  : (value as LabelDesign['elements'][LabelElement]['size']),
                            };
                            setOverride(overrideSize, {
                              ...override,
                              elements: { ...override.elements, [element]: next },
                            });
                          }}
                        >
                          <option value="base">{t('labelDesign.asBase')}</option>
                          {LABEL_SIZES.map((v) => (
                            <option key={v} value={v}>
                              {t(`labelDesign.sizes.${v}`)}
                            </option>
                          ))}
                        </select>
                        {bilingual(element) ? (
                          <select
                            aria-label={t('labelDesign.overrideLangOf', {
                              element: elementName(element),
                            })}
                            value={change.lang ?? 'base'}
                            onChange={(event) => {
                              const value = event.target.value;
                              const next = {
                                ...change,
                                lang: value === 'base' ? undefined : (value as LabelLanguage),
                              };
                              setOverride(overrideSize, {
                                ...override,
                                elements: { ...override.elements, [element]: next },
                              });
                            }}
                          >
                            <option value="base">{t('labelDesign.asBase')}</option>
                            {LABEL_LANGUAGES.map((v) => (
                              <option key={v} value={v}>
                                {t(`labelDesign.langs.${v}`)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span />
                        )}
                      </li>
                    );
                  })}
              </ul>
              <Button variant="ghost" onPress={() => setOverride(overrideSize, null)}>
                <Trash2 className={iconClass.sm} aria-hidden="true" />
                {t('labelDesign.overrideRemove')}
              </Button>
            </>
          )}
        </Card>
      </div>

      <Card rise index={6} className={styles.previewCard}>
        <CardHead title={t('labelDesign.previewTitle')} />
        <div className={styles.texts}>
          <TextField
            label={t('labelDesign.itemSearch')}
            value={itemSearch}
            onChange={setItemSearch}
            autoComplete="off"
          />
          <SelectField
            id="label-preview-item"
            label={t('labelDesign.item')}
            value={itemId}
            onChange={setItemId}
            options={[
              { value: '', label: t('labelDesign.sampleItem') },
              ...(found.data?.items ?? [])
                .filter((i) => i.isActive)
                .map((i) => ({ value: i.id, label: `${name(i)} · ${i.code}` })),
            ]}
          />
        </div>
        <div className={styles.labelPreviews}>
          {previews.map((p) => (
            <figure
              key={p.size.id}
              className={styles.labelPreview}
              data-testid={`label-design-preview-${p.size.code}`}
            >
              <figcaption>
                <span>
                  {name(p.size)} ({p.size.widthMm} × {p.size.heightMm})
                </span>
                {p.layout.ok ? (
                  p.layout.fitted ? (
                    <Chip tone="info">{t('labelDesign.fitted')}</Chip>
                  ) : (
                    <Chip tone="ok">{t('labelDesign.fits')}</Chip>
                  )
                ) : (
                  <Chip tone="warn">
                    {t('labelDesign.wontFit', { size: `${p.size.widthMm} × ${p.size.heightMm}` })}
                  </Chip>
                )}
              </figcaption>
              {p.extrasWontFit && (
                <Note>
                  {t('labelDesign.extrasWontFit', {
                    size: `${p.size.widthMm} × ${p.size.heightMm}`,
                  })}
                </Note>
              )}
              {p.layout.ok ? (
                <img
                  src={p.url || undefined}
                  alt={t('labelDesign.previewOf', {
                    size: `${p.size.widthMm} × ${p.size.heightMm}`,
                  })}
                  style={
                    {
                      '--label-w': `${p.size.widthMm}mm`,
                      '--label-h': `${p.size.heightMm}mm`,
                    } as CSSProperties
                  }
                />
              ) : (
                <Alert tone="warn">{t(`labelDesign.refused.${p.layout.reason}`)}</Alert>
              )}
            </figure>
          ))}
        </div>
      </Card>
    </div>
  );
}
