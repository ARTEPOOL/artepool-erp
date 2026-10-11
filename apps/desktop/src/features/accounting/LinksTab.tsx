/**
 * Accounting → Event links: which account each automatic posting uses (posting map, decision
 * 0018). The links are data the accountant can change without programming. Each event needs an
 * active account that receives postings, of its fixed type and control kind.
 */
import { useState } from 'react';
import { Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_LINK_KEYS,
  type AccountItem,
  type AccountLink,
  type AccountsResponse,
} from '@artepool/shared/contracts';
import { Button, Card, iconClass, Note, SelectField, tableClasses, useToast } from '../../ui';
import { useSave } from '../../api/hooks';
import { useCan } from '../auth/context';
import { MD_KEYS } from '../masterdata/refs';
import {
  listClasses as styles,
  SaveError,
  useAccountLabel,
  useAccountOptions,
} from '../settings/lists/parts';

/** An account this event may use: active, postable, its type, and control only if required. */
export const suitsLink = (link: AccountLink) => (account: AccountItem) =>
  account.isActive &&
  account.isPostable &&
  account.accountType === link.requiredType &&
  account.isControl === link.needsControl;

export function LinksTab({ data }: { data: AccountsResponse }) {
  const { t } = useTranslation('accounting');
  const can = useCan();
  const canManage = can('accounts.manage');
  const links = ACCOUNT_LINK_KEYS.flatMap((key) => data.links.filter((l) => l.key === key));
  return (
    <Card rise index={2} padding="table">
      <div className={styles.tableHead}>
        <Note>{canManage ? t('links.help') : t('links.readOnly')}</Note>
      </div>
      <table className={tableClasses.table}>
        <thead>
          <tr>
            <th>{t('links.event')}</th>
            <th>{t('links.needs')}</th>
            <th>{t('links.account')}</th>
          </tr>
        </thead>
        <tbody>
          {links.map((link) => (
            <LinkRow
              key={`${link.key}-${link.rowVersion}`}
              link={link}
              accounts={data.accounts}
              canManage={canManage}
            />
          ))}
          {links.length === 0 && (
            <tr className={tableClasses.empty}>
              <td colSpan={3}>{t('links.empty')}</td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

function LinkRow(props: { link: AccountLink; accounts: AccountItem[]; canManage: boolean }) {
  const { t } = useTranslation('accounting');
  const toast = useToast();
  const queryClient = useQueryClient();
  const label = useAccountLabel();
  const options = useAccountOptions();
  const { link } = props;
  const [value, setValue] = useState(link.accountId);
  const title = t(`links.keys.${link.key}.title`);
  const save = useSave(
    (api, body: { accountId: string; rowVersion: number }, key) =>
      api.patch(`/api/v1/account-links/${link.key}`, body, { idempotencyKey: key }),
    { invalidate: [MD_KEYS.accounts], onSuccess: () => toast(t('links.saved', { event: title })) },
  );
  const current = props.accounts.find((a) => a.id === link.accountId);
  const needs = `${t(`types.${link.requiredType}`)} · ${
    link.needsControl ? t('links.control') : t('links.notControl')
  }`;

  return (
    <tr data-testid={`link-${link.key}`}>
      <td>
        <span className={styles.treeName}>
          <b>{title}</b>
          <span className={tableClasses.sub}>{t(`links.keys.${link.key}.body`)}</span>
        </span>
      </td>
      <td>{needs}</td>
      <td>
        {props.canManage ? (
          <div className={styles.linkCell}>
            <div className={styles.linkSave}>
              <SelectField
                id={`link-${link.key}`}
                label={t('links.accountFor', { event: title })}
                value={value}
                onChange={setValue}
                options={options(props.accounts, suitsLink(link), value)}
              />
              <Button
                variant="primary"
                isDisabled={value === link.accountId || !value}
                busy={save.isPending}
                aria-label={t('links.saveFor', { event: title })}
                onPress={() => save.mutate({ accountId: value, rowVersion: link.rowVersion })}
              >
                <Save className={iconClass.sm} aria-hidden="true" />
                {t('links.save')}
              </Button>
            </div>
            <SaveError
              error={save.error}
              onReload={() => {
                save.reset();
                void queryClient.invalidateQueries({ queryKey: MD_KEYS.accounts });
              }}
            />
          </div>
        ) : (
          <bdi>{current ? label(current) : t('masterdata:none')}</bdi>
        )}
      </td>
    </tr>
  );
}
