import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdjustmentDetail, CreateAdjustmentRequest } from '@artepool/shared/contracts';
import { ApiError } from '../../api/client';
import { useSave } from '../../api/hooks';
import {
  Alert,
  Button,
  cx,
  Dialog,
  DialogFooter,
  InfoBar,
  Segmented,
  SelectField,
  TextField,
  useToast,
} from '../../ui';
import { useCan, useErrorText } from '../auth/context';
import { ApprovalDialog } from '../masterdata/ApprovalDialog';
import { localName, MD_KEYS, useReasonCodes, useUnits } from '../masterdata/refs';
import { quantityText } from './form';
import {
  buildAdjustment,
  effectiveKind,
  OPERATION_PERMISSION,
  OPERATIONS,
  REASON_CATEGORY,
  signedQuantity,
  typedQuantity,
  type AdjustErrors,
  type AdjustForm,
  type Operation,
} from './stock';
import mdStyles from '../masterdata/masterdata.module.css';
import styles from './items.module.css';

/** The item being adjusted and its stock right now (thousandths, all warehouses). */
export interface AdjustTarget {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  unitId: string;
  onHandMilli: string;
  defectiveMilli: string;
}

const isApprovalRequired = (error: unknown) =>
  error instanceof ApiError &&
  error.code === 'PERMISSION_DENIED' &&
  error.details.rule === 'APPROVAL_REQUIRED';

/**
 * Design 07 "Stock adjustment" for one item. The stock is never edited directly: a numbered
 * adjustment (ADJ-…) is recorded and the stock is calculated from it. Above the value limit a
 * supervisor approves (decision 0041), then the same request is sent again with the approval.
 */
export function AdjustDialog(props: {
  item: AdjustTarget;
  initial?: Operation;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('items');
  const can = useCan();
  const errorText = useErrorText();
  const toast = useToast();
  const name = localName(i18n.language);
  const units = useUnits();
  const reasonCodes = useReasonCodes();
  const allowed = OPERATIONS.filter((op) => can(OPERATION_PERMISSION[op]));
  const canCost = can('stock.view_cost');
  const [form, setForm] = useState<AdjustForm>({
    operation: props.initial && allowed.includes(props.initial) ? props.initial : allowed[0]!,
    quantity: '',
    reasonCodeId: '',
    note: '',
    unitCost: '',
  });
  const [errors, setErrors] = useState<AdjustErrors>({});
  const [awaitingApproval, setAwaitingApproval] = useState<CreateAdjustmentRequest | null>(null);

  const save = useSave(
    (api, body: CreateAdjustmentRequest, key) =>
      api.post<AdjustmentDetail>('/api/v1/stock/adjustments', body, { idempotencyKey: key }),
    {
      invalidate: [MD_KEYS.items, MD_KEYS.stock],
      onSuccess: (result) => {
        toast(t('adjust.done', { number: result.docNumber ?? '' }));
        props.onClose();
      },
    },
  );

  const set = <K extends keyof AdjustForm>(key: K, value: AdjustForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const unit = units.data?.find((u) => u.id === props.item.unitId);
  const unitName = unit ? name(unit) : '';
  const onHand = BigInt(props.item.onHandMilli);
  const defective = BigInt(props.item.defectiveMilli);
  const typed = typedQuantity(form.quantity);
  const { kind, lineMilli } = effectiveKind(form.operation, typed, onHand);
  const reasons = (reasonCodes.data ?? []).filter((r) => r.isActive);
  const options = kind ? reasons.filter((r) => r.category === REASON_CATEGORY[kind]) : [];
  const reason = options.find((r) => r.id === form.reasonCodeId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = buildAdjustment(form, {
      itemId: props.item.id,
      onHandMilli: onHand,
      unitDecimals: unit?.decimals ?? 3,
      canCost,
      reasons,
    });
    setErrors(result.errors);
    if (!result.body) return;
    const body = result.body;
    save.mutate(body, {
      onError: (caught) => {
        if (isApprovalRequired(caught)) setAwaitingApproval(body);
      },
    });
  };

  const fieldError = (field: keyof AdjustErrors) => (errors[field] ? t(errors[field]) : undefined);
  const qtyText = (milli: bigint) => (
    <>
      <bdi>{quantityText(milli.toString())}</bdi> {unitName}
    </>
  );
  const quantityLabel: Record<Operation, string> = {
    counted: t('adjust.counted'),
    increase: t('adjust.quantityIn'),
    decrease: t('adjust.quantityOut'),
    status_change: t('adjust.quantityDefective'),
    write_off: t('adjust.quantityWriteOff'),
  };
  const diff = form.operation === 'counted' && typed !== null ? typed - onHand : null;
  const showCost = canCost && kind === 'increase';
  const serverError = save.error !== null && !isApprovalRequired(save.error) ? save.error : null;

  return (
    <>
      <Dialog isOpen onClose={props.onClose} title={t('adjust.title')}>
        <form onSubmit={submit} noValidate className={mdStyles.form}>
          <div>
            <b>{name(props.item)}</b>
            <span className={styles.muted}>
              {' · '}
              <bdi>{props.item.code}</bdi>
            </span>
          </div>
          <div className={styles.field}>
            <span className={styles.label}>{t('adjust.operation')}</span>
            <Segmented
              label={t('adjust.operation')}
              value={form.operation}
              onChange={(op) => {
                setErrors({});
                setForm((f) => ({ ...f, operation: op, reasonCodeId: '', unitCost: '' }));
              }}
              options={allowed.map((op) => ({ value: op, label: t(`adjust.ops.${op}`) }))}
            />
          </div>
          <TextField
            label={quantityLabel[form.operation]}
            value={form.quantity}
            onChange={(value) => set('quantity', value)}
            inputMode="numeric"
            autoComplete="off"
            ltr
            size="lg"
            isRequired
            hint={unitName ? t('dialog.reorderHint', { unit: unitName }) : undefined}
            error={fieldError('quantity')}
          />
          {form.operation === 'counted' ? (
            <div className={styles.diffbox} data-testid="adjust-diff">
              <div>
                <span>{t('adjust.inSystem')}</span>
                <b>
                  <bdi>{quantityText(onHand.toString())}</bdi>
                </b>
              </div>
              <div>
                <span>{t('adjust.countedShort')}</span>
                <b>
                  <bdi>{typed === null ? '—' : quantityText(typed.toString())}</bdi>
                </b>
              </div>
              <div
                className={cx(
                  diff !== null && diff < 0n && styles.neg,
                  diff !== null && diff > 0n && styles.pos,
                )}
              >
                <span>{t('adjust.difference')}</span>
                <b>
                  <bdi>{diff === null ? '—' : signedQuantity(diff)}</bdi>
                </b>
                {kind && <span>{t(`adjust.ops.${kind}`)}</span>}
              </div>
            </div>
          ) : (
            <p className={styles.muted}>
              {t('adjust.onHand')} {qtyText(onHand)} · {t('adjust.defective')} {qtyText(defective)}
            </p>
          )}
          <SelectField
            id="adjust-reason"
            label={t('adjust.reason')}
            value={reason ? reason.id : ''}
            onChange={(value) => set('reasonCodeId', value)}
            isDisabled={!kind}
            options={[
              { value: '', label: kind ? t('dialog.choose') : t('adjust.typeFirst') },
              ...options.map((r) => ({ value: r.id, label: name(r) })),
            ]}
          />
          {fieldError('reasonCodeId') && (
            <span className={styles.fieldError}>{fieldError('reasonCodeId')}</span>
          )}
          <TextField
            label={reason?.requiresNote ? t('adjust.noteRequired') : t('adjust.note')}
            value={form.note}
            onChange={(value) => set('note', value)}
            multiline
            isRequired={reason?.requiresNote ?? false}
            error={fieldError('note')}
          />
          {showCost && (
            <TextField
              label={t('adjust.unitCost')}
              value={form.unitCost}
              onChange={(value) => set('unitCost', value)}
              inputMode="numeric"
              autoComplete="off"
              ltr
              hint={t('adjust.unitCostHint')}
              error={fieldError('unitCost')}
            />
          )}
          {lineMilli !== null && lineMilli > 0n && kind && (
            <p className={styles.muted} data-testid="adjust-summary">
              {t(`adjust.ops.${kind}`)}: {qtyText(lineMilli)}
            </p>
          )}
          <InfoBar>{t('adjust.explain')}</InfoBar>
          {serverError !== null && <Alert>{errorText(serverError)}</Alert>}
          <DialogFooter>
            <Button onPress={props.onClose}>{t('adjust.cancel')}</Button>
            <Button type="submit" variant="primary" busy={save.isPending}>
              {t('adjust.save')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
      {awaitingApproval && (
        <ApprovalDialog
          permission="stock.adjust_over_threshold"
          explanation={t('adjust.approvalExplain')}
          subject={
            <>
              <b>{name(props.item)}</b> · <bdi>{props.item.code}</bdi>
            </>
          }
          context={{
            action: 'stock_adjustment',
            kind: awaitingApproval.kind,
            lines: awaitingApproval.lines.map((l) => ({
              itemId: l.itemId,
              quantityMilli: l.quantityMilli,
            })),
          }}
          onApproved={(approvalId) => {
            const body = { ...awaitingApproval, approvalId };
            setAwaitingApproval(null);
            save.mutate(body);
          }}
          onClose={() => setAwaitingApproval(null)}
        />
      )}
    </>
  );
}
