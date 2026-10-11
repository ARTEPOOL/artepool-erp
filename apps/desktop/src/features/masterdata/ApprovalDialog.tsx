import { useState, type FormEvent, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type { ApprovalRequest, ApprovalResponse, Approver } from '@artepool/shared/contracts';
import { useApi, useSave } from '../../api/hooks';
import { Alert, Button, Dialog, DialogFooter, InfoBar, SelectField, TextField } from '../../ui';
import { useDisplayName, useErrorText } from '../auth/context';
import styles from './masterdata.module.css';

/**
 * A supervisor's one-time approval (architecture §5.5, decision 0041): the supervisor chooses
 * their name and types their PIN on this PC, with a reason. The server checks that they hold the
 * permission; the approval is used once, by the action that asked for it.
 */
export function ApprovalDialog(props: {
  permission: string;
  title?: ReactNode;
  explanation?: ReactNode;
  /** What is being approved, shown above the form. */
  subject?: ReactNode;
  context?: Record<string, unknown>;
  onApproved: (approvalId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('masterdata');
  const api = useApi();
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const [approverId, setApproverId] = useState('');
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const approvers = useQuery({
    queryKey: ['approvers', props.permission],
    queryFn: async () =>
      (
        await api.get<{ approvers: Approver[] }>(
          `/api/v1/approvals/approvers?permission=${encodeURIComponent(props.permission)}`,
        )
      ).approvers,
  });
  const approve = useSave((a, body: ApprovalRequest) =>
    a.post<ApprovalResponse>('/api/v1/approvals', body),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (!approverId || !pin.trim()) return setProblem(t('fields.required'));
    if (reason.trim().length < 3) return setProblem(t('deactivate.reasonTooShort'));
    approve.mutate(
      {
        permission: props.permission,
        approverId,
        pin: pin.trim(),
        reason: reason.trim(),
        context: props.context ?? {},
      },
      {
        onSuccess: (result) => props.onApproved(result.approvalId),
        onError: () => setPin(''),
      },
    );
  };

  const list = approvers.data ?? [];
  return (
    <Dialog isOpen onClose={props.onClose} title={props.title ?? t('approval.title')}>
      <form onSubmit={submit} noValidate className={styles.form}>
        <InfoBar icon={<ShieldCheck aria-hidden="true" />}>
          {props.explanation ?? t('approval.explain')}
        </InfoBar>
        {props.subject && <div>{props.subject}</div>}
        {approvers.isSuccess && list.length === 0 && <Alert>{t('approval.noApprovers')}</Alert>}
        <SelectField
          id="approval-approver"
          label={t('approval.approver')}
          value={approverId}
          onChange={setApproverId}
          options={[
            { value: '', label: t('approval.choose') },
            ...list.map((a) => ({ value: a.id, label: nameOf(a) })),
          ]}
        />
        <TextField
          label={t('approval.pin')}
          value={pin}
          onChange={setPin}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          ltr
          isRequired
        />
        <TextField
          label={t('approval.reason')}
          value={reason}
          onChange={setReason}
          placeholder={t('approval.reasonHint')}
          isRequired
        />
        {problem && <Alert>{problem}</Alert>}
        {approve.error !== null && <Alert>{errorText(approve.error)}</Alert>}
        <DialogFooter>
          <Button onPress={props.onClose}>{t('actions.cancel')}</Button>
          <Button type="submit" variant="primary" busy={approve.isPending}>
            {t('approval.approve')}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
