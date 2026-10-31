/**
 * Settings → Print designer (design 11; decisions 0020, 0064–0067). The owner changes how invoices,
 * quotations, credit notes and the thermal receipt look, with a live preview. Fields UAE VAT law
 * requires are listed as "Required" and cannot be switched off. Every save is a new version;
 * documents already issued keep printing with their own version.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Lock, Printer, RotateCcw, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BALANCE_BLOCK_MODES,
  FIELDS_BY_KIND,
  LOCKED_BY_KIND,
  TEMPLATE_TEXTS,
  defaultTemplateSettings,
  type DesignedKind,
  type FilePayload,
  type OptionalField,
  type PreviewTemplateResponse,
  type PrintTemplateItem,
  type PrintTemplatesResponse,
  type SaveTemplateRequest,
  type TemplateSettings,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { formatDateTime } from '../../../lib/format';
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
  Tabs,
  TextField,
  useToast,
} from '../../../ui';
import { useCan, useDisplayName, useErrorText } from '../../auth/context';
import { useCompany } from '../../masterdata/refs';
import { receiptModel } from '../../pos/receipt/layout';
import { useReceiptLogo } from '../../pos/receipt/logo';
import { printReceiptImage } from '../../pos/receipt/printer';
import { renderReceipt } from '../../pos/receipt/render';
import { printPdf } from '../../sales/print';
import { SaveProblem } from '../company/SaveProblem';
import { CardHead, NoAccess, PanelHeader } from '../parts';
import { LabelDesigner } from './LabelDesigner';
import { ReceiptLogo } from './ReceiptLogo';
import { sampleReceipt } from './sample';
import styles from './print.module.css';

export const PRINT_KEY = ['settings', 'print-templates'];
/** A4 at 96 dpi: the size the page is laid out at before it is scaled into the preview. */
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;

export function PrintDesignerPanel() {
  const { t } = useTranslation('settings');
  const can = useCan();
  const api = useApi();
  const errorText = useErrorText();
  const query = useQuery({
    queryKey: PRINT_KEY,
    queryFn: () => api.get<PrintTemplatesResponse>('/api/v1/print-templates'),
  });
  const [kind, setKind] = useState<DesignedKind | 'barcode_label'>('tax_invoice_a4');
  if (!can('print_templates.manage')) return <NoAccess />;
  const current = query.data?.templates.find((x) => x.kind === kind);
  return (
    <>
      <PanelHeader title={t('print.title')} subtitle={t('print.subtitle')} />
      <Tabs
        label={t('print.kinds.label')}
        value={kind}
        onChange={setKind}
        tabs={(
          [
            'tax_invoice_a4',
            'quotation_a4',
            'credit_note_a4',
            'receipt_thermal',
            'barcode_label',
          ] as const
        ).map((k) => ({ value: k, label: t(`print.kinds.${k}`) }))}
      />
      {query.isError && <Alert>{errorText(query.error)}</Alert>}
      {kind === 'barcode_label' && <LabelDesigner />}
      {kind !== 'barcode_label' && query.data && current && (
        <Designer key={`${kind}:${current.versionId}`} template={current} data={query.data} />
      )}
    </>
  );
}

function Designer({
  template,
  data,
}: {
  template: PrintTemplateItem;
  data: PrintTemplatesResponse;
}) {
  const { t } = useTranslation('settings');
  const api = useApi();
  const toast = useToast();
  const errorText = useErrorText();
  const nameOf = useDisplayName();
  const queryClient = useQueryClient();
  const kind = template.kind;
  const thermal = kind === 'receipt_thermal';
  const [settings, setSettings] = useState<TemplateSettings>(template.settings);
  const [printProblem, setPrintProblem] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const changed = JSON.stringify(settings) !== JSON.stringify(template.settings);
  const set = (patch: Partial<TemplateSettings>) => setSettings((s) => ({ ...s, ...patch }));
  const setField = (field: OptionalField, on: boolean) =>
    setSettings((s) => ({ ...s, fields: { ...s.fields, [field]: on } }));

  const save = useSave(
    (client, body: SaveTemplateRequest, key) =>
      client.post<PrintTemplateItem>(`/api/v1/print-templates/${kind}/versions`, body, {
        idempotencyKey: key,
      }),
    {
      invalidate: [PRINT_KEY],
      onSuccess: (saved) => toast(t('print.saved', { version: saved.versionNo })),
    },
  );

  const testPrint = async () => {
    setPrintProblem(null);
    setPrinting(true);
    try {
      if (thermal) {
        const outcome = await printReceiptImage(receiptImage);
        if (!outcome.printed) setPrintProblem(t(`print.testThermal.${outcome.reason}`));
      } else {
        const file = await api.post<FilePayload>(`/api/v1/print-templates/${kind}/test-pdf`, {
          settings,
        });
        await printPdf(file);
      }
    } catch (error) {
      setPrintProblem(errorText(error));
    } finally {
      setPrinting(false);
    }
  };

  // The thermal receipt is drawn here, exactly as the POS draws it.
  const company = useCompany();
  const logo = useReceiptLogo();
  const { i18n } = useTranslation();
  const [fullSample, setFullSample] = useState(false);
  const receiptImage = useMemo(() => {
    if (!thermal) return null;
    const sample = sampleReceipt(company.data?.company ?? null, settings, fullSample);
    const model = receiptModel(sample, settings.language, {
      ar: i18n.getFixedT('ar', 'pos'),
      en: i18n.getFixedT('en', 'pos'),
    });
    return renderReceipt(model, undefined, logo);
  }, [thermal, company.data, settings, fullSample, i18n, logo]);

  const offered = FIELDS_BY_KIND[kind];
  return (
    <div className={styles.layout}>
      <div className={styles.controls}>
        <Card rise index={1} className={styles.card}>
          <div className={styles.version}>
            <span>
              {t('print.version', { version: template.versionNo })} ·{' '}
              <bdi>{formatDateTime(template.savedAt)}</bdi>
              {template.savedBy && <> · {nameOf(template.savedBy)}</>}
            </span>
            {changed && <Chip tone="warn">{t('print.unsaved')}</Chip>}
          </div>
          <div className={styles.buttons}>
            <Button onPress={() => setSettings(defaultTemplateSettings(kind))}>
              <RotateCcw className={iconClass.sm} aria-hidden="true" />
              {t('print.default')}
            </Button>
            <Button busy={printing} onPress={() => void testPrint()}>
              <Printer className={iconClass.sm} aria-hidden="true" />
              {t('print.testPrint')}
            </Button>
            <Button
              variant="primary"
              isDisabled={!changed || !data.canEdit}
              busy={save.isPending}
              onPress={() => save.mutate({ settings, basedOnVersionId: template.versionId })}
            >
              <Save className={iconClass.sm} aria-hidden="true" />
              {t('print.save')}
            </Button>
          </div>
          {printProblem && <Alert tone="warn">{printProblem}</Alert>}
          <SaveProblem
            error={save.error}
            onReload={() => void queryClient.invalidateQueries({ queryKey: PRINT_KEY })}
          />
        </Card>

        <Card rise index={2} className={styles.card}>
          <CardHead title={t('print.look')} />
          {offered.includes('logo') && (
            <>
              <Switch isSelected={settings.fields.logo} onChange={(on) => setField('logo', on)}>
                {t('print.fields.logo')}
              </Switch>
              {!data.hasLogo && !(thermal && data.hasReceiptLogo) && settings.fields.logo && (
                <Note>{t('print.noLogo')}</Note>
              )}
              {settings.fields.logo && thermal && <ReceiptLogo canEdit={data.canEdit} />}
              {settings.fields.logo && !thermal && (
                <>
                  <Segmented
                    label={t('print.logoPosition')}
                    value={settings.logoPosition}
                    onChange={(logoPosition) => set({ logoPosition })}
                    options={(['beside', 'center', 'opposite'] as const).map((v) => ({
                      value: v,
                      label: t(`print.positions.${v}`),
                    }))}
                  />
                  <label className={styles.slider}>
                    <span>{t('print.logoSize')}</span>
                    <input
                      type="range"
                      min={10}
                      max={60}
                      step={1}
                      value={settings.logoSizeMm}
                      onChange={(e) => set({ logoSizeMm: Number(e.target.value) })}
                      aria-valuetext={t('print.logoSizeValue', { mm: settings.logoSizeMm })}
                    />
                    <bdi>{t('print.logoSizeValue', { mm: settings.logoSizeMm })}</bdi>
                  </label>
                </>
              )}
            </>
          )}
          {!thermal && (
            <label className={styles.color}>
              <span>{t('print.color')}</span>
              <input
                type="color"
                value={settings.color}
                onChange={(e) => set({ color: e.target.value })}
                aria-describedby="print-color-hint"
              />
              <bdi>{settings.color}</bdi>
              <small id="print-color-hint">{t('print.colorHint')}</small>
            </label>
          )}
          <Segmented
            label={t('print.language')}
            value={settings.language}
            onChange={(language) => set({ language })}
            options={(['both', 'ar', 'en'] as const).map((v) => ({
              value: v,
              label: t(`print.languages.${v}`),
            }))}
          />
          {!thermal && (
            <Segmented
              label={t('print.textSize')}
              value={settings.textSize}
              onChange={(textSize) => set({ textSize })}
              options={(['small', 'normal', 'large'] as const).map((v) => ({
                value: v,
                label: t(`print.sizes.${v}`),
              }))}
            />
          )}
          {thermal ? (
            <Segmented
              label={t('print.paperWidth')}
              value={String(settings.paperWidthMm) as '80' | '58'}
              onChange={(v) => set({ paperWidthMm: v === '58' ? 58 : 80 })}
              options={[
                { value: '80', label: t('print.widths.80') },
                { value: '58', label: t('print.widths.58') },
              ]}
            />
          ) : (
            <Segmented
              label={t('print.margins')}
              value={settings.margins}
              onChange={(margins) => set({ margins })}
              options={(['narrow', 'normal', 'wide'] as const).map((v) => ({
                value: v,
                label: t(`print.marginSizes.${v}`),
              }))}
            />
          )}
        </Card>

        <Card rise index={3} className={styles.card}>
          <CardHead title={t('print.fieldsTitle')} />
          <ul className={styles.locked} aria-label={t('print.requiredLabel')}>
            {LOCKED_BY_KIND[kind].map((field) => (
              <li key={field}>
                <Lock className={iconClass.sm} aria-hidden="true" />
                <span>{t(`print.locked.${field}`)}</span>
                <Chip tone="neutral">{t('print.required')}</Chip>
              </li>
            ))}
          </ul>
          <div className={styles.switches}>
            {offered
              .filter((f) => f !== 'logo')
              .map((field) => (
                <Switch
                  key={field}
                  isSelected={settings.fields[field]}
                  onChange={(on) => setField(field, on)}
                >
                  {t(`print.fields.${field}`)}
                  {field === 'customerAddress' && kind !== 'quotation_a4' && (
                    <small className={styles.why}>{t('print.customerAddressLocked')}</small>
                  )}
                  {field === 'lineDiscount' && kind !== 'quotation_a4' && (
                    <small className={styles.why}>{t('print.discountLocked')}</small>
                  )}
                </Switch>
              ))}
          </div>
          {offered.includes('bankDetails') && settings.fields.bankDetails && (
            <>
              <SelectField
                id="print-bank"
                label={t('print.bankAccount')}
                value={settings.bankAccountId ?? ''}
                onChange={(v) => set({ bankAccountId: v || null })}
                options={[
                  { value: '', label: t('print.chooseBank') },
                  ...data.bankAccounts.map((a) => ({
                    value: a.id,
                    label: `${a.bankName} · ${a.iban}`,
                  })),
                ]}
              />
              {data.bankAccounts.length === 0 && <Note>{t('print.noBank')}</Note>}
            </>
          )}
          {kind === 'tax_invoice_a4' && (
            <div className={styles.choice}>
              <span aria-hidden="true">{t('print.balanceBlock')}</span>
              <Segmented
                label={t('print.balanceBlock')}
                value={settings.balanceBlock}
                onChange={(balanceBlock) => set({ balanceBlock })}
                options={BALANCE_BLOCK_MODES.map((v) => ({
                  value: v,
                  label: t(`print.balanceBlocks.${v}`),
                }))}
              />
              <Note>{t('print.balanceBlockHint')}</Note>
            </div>
          )}
        </Card>

        <Card rise index={4} className={styles.card}>
          <CardHead title={t('print.textsTitle')} />
          <div className={styles.texts}>
            {TEMPLATE_TEXTS.map((key) => (
              <TextField
                key={key}
                label={t(`print.texts.${key}`)}
                value={settings.texts[key]}
                onChange={(v) => set({ texts: { ...settings.texts, [key]: v } })}
                multiline={key.startsWith('terms')}
                maxLength={500}
                ltr={key.endsWith('En')}
              />
            ))}
          </div>
          {kind === 'quotation_a4' && <Note>{t('print.quotationTerms')}</Note>}
        </Card>
        <Note>{t('print.versionsNote')}</Note>
      </div>

      <Card rise index={5} className={styles.previewCard}>
        <CardHead title={t('print.preview')}>
          {thermal && (
            <Switch isSelected={fullSample} onChange={setFullSample}>
              {t('print.fullSample')}
            </Switch>
          )}
        </CardHead>
        {thermal ? (
          receiptImage && (
            <img
              className={styles.receipt}
              src={receiptImage.canvas.toDataURL('image/png')}
              alt={t('print.previewAlt')}
              data-width={settings.paperWidthMm}
            />
          )
        ) : (
          <A4Preview kind={kind} settings={settings} />
        )}
      </Card>
    </div>
  );
}

/** The A4 page as the server renders it, refreshed shortly after each change. */
function A4Preview({ kind, settings }: { kind: DesignedKind; settings: TemplateSettings }) {
  const { t } = useTranslation('settings');
  const api = useApi();
  const errorText = useErrorText();
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const latest = useRef(0);
  const text = JSON.stringify(settings);
  useEffect(() => {
    const n = ++latest.current;
    const timer = setTimeout(() => {
      api
        .post<PreviewTemplateResponse>(`/api/v1/print-templates/${kind}/preview`, {
          settings: JSON.parse(text) as TemplateSettings,
        })
        .then((r) => {
          if (n !== latest.current || !r.html) return;
          setProblem(null);
          setUrl((old) => {
            if (old) URL.revokeObjectURL(old);
            return URL.createObjectURL(new Blob([r.html!], { type: 'text/html' }));
          });
        })
        .catch((error: unknown) => n === latest.current && setProblem(errorText(error)));
    }, 350);
    return () => clearTimeout(timer);
  }, [api, kind, text, errorText]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  // The page is laid out at its real A4 width and scaled down to fit the card.
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / A4_WIDTH_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [url]);
  if (problem) return <Alert>{problem}</Alert>;
  return url ? (
    <div ref={box} className={styles.pageBox} style={{ blockSize: A4_HEIGHT_PX * scale }}>
      {/* Sandboxed: the page is shown, nothing in it can run. */}
      <iframe
        className={styles.page}
        src={url}
        sandbox=""
        title={t('print.previewAlt')}
        style={{ transform: `scale(${scale})` }}
      />
    </div>
  ) : (
    <p className={styles.loading}>{t('print.loading')}</p>
  );
}
