/**
 * Opening the drawer shift (decision 0004): the cashier types the float taken from the safe. Only
 * this cashier then sells and moves cash on this drawer until they close it.
 */
import { useState, type FormEvent } from 'react';
import { DoorOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MoneyFormatError, parseFils } from '@artepool/shared';
import type { ShiftSummary } from '@artepool/shared/contracts';
import { useSave } from '../../../api/hooks';
import { Alert, Button, Card, CardHeader, iconClass, Note, TextField } from '../../../ui';
import { useCan, useErrorText } from '../../auth/context';
import { POS_INVALIDATE, POS_PATHS } from '../api';
import { kickDrawer } from '../receipt/printer';
import styles from '../pos.module.css';

export function OpenShiftCard() {
  const { t } = useTranslation('pos');
  const can = useCan();
  const errorText = useErrorText();
  const [float, setFloat] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const open = useSave(
    (api, floatFils: string, key) =>
      api.post<ShiftSummary>(
        POS_PATHS.shifts,
        { openingFloatFils: floatFils },
        { idempotencyKey: key },
      ),
    {
      invalidate: POS_INVALIDATE,
      onSuccess: (_shift, openingFloatFils) => {
        if (BigInt(openingFloatFils) > 0n) void kickDrawer();
      },
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    let fils: bigint;
    try {
      fils = float.trim() === '' ? 0n : parseFils(float.trim());
    } catch (e) {
      if (e instanceof MoneyFormatError) return setProblem(t('shiftOpen.badAmount'));
      throw e;
    }
    if (fils < 0n) return setProblem(t('shiftOpen.badAmount'));
    open.mutate(fils.toString(), { onError: (e) => setProblem(errorText(e)) });
  };
  if (!can('shifts.open')) return <Alert tone="warn">{t('shiftOpen.noPermission')}</Alert>;
  return (
    <Card className={styles.openCard}>
      <CardHeader title={t('shiftOpen.title')} />
      <form onSubmit={submit} noValidate className={styles.payForm}>
        <Note>{t('shiftOpen.help')}</Note>
        <TextField
          label={t('shiftOpen.float')}
          value={float}
          onChange={setFloat}
          inputMode="decimal"
          ltr
          autoFocus
          placeholder="0.00"
        />
        {problem && <Alert>{problem}</Alert>}
        <Button type="submit" variant="primary" busy={open.isPending}>
          <DoorOpen className={iconClass.sm} aria-hidden="true" />
          {t('shiftOpen.open')}
        </Button>
      </form>
    </Card>
  );
}
