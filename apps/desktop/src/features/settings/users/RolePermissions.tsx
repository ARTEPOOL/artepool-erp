import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PermissionInfo, RoleInfo } from '@artepool/shared/contracts';
import { formatFils, formatScaled, parseFils, parseScaled } from '@artepool/shared/money';
import { Alert, Button, Card, Chip, Note, Switch, TextField, useToast } from '../../../ui';
import { useCan, useDisplayName, useErrorText } from '../../auth/context';
import { KEYS, useSave } from '../api';
import { settingsClasses as styles } from '../parts';

/** Modules in the order the owner thinks about them. */
const MODULE_ORDER = [
  'pos',
  'sales',
  'cash',
  'inventory',
  'masterdata',
  'ledger',
  'export',
  'users',
  'audit',
  'system',
];

/** Sales permissions that make the discount limit relevant. */
const SELLING = ['pos.sell', 'invoices.create'];

interface Draft {
  permissions: Set<string>;
  percent: string;
  amount: string;
}

const draftOf = (role: RoleInfo): Draft => ({
  permissions: new Set(role.permissions),
  // Basis points with 2 implied decimals = percent (500 → "5.00"); fils → AED. No floats.
  percent: formatScaled(BigInt(role.maxDiscountBp), 2),
  amount: formatFils(BigInt(role.maxDiscountFils)),
});

/** Design 13 "Role permissions": switches grouped by area, the discount limit, save/cancel. */
export function RolePermissions(props: {
  role: RoleInfo;
  permissions: PermissionInfo[];
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const can = useCan();
  const nameOf = useDisplayName();
  const errorText = useErrorText();
  const toast = useToast();
  const { role, onDirtyChange } = props;
  const [draft, setDraft] = useState<Draft>(() => draftOf(role));
  const [error, setError] = useState<string | null>(null);
  const isOwnerRole = role.code === 'owner';
  const editable = can('roles.manage') && !isOwnerRole;

  const original = useMemo(() => draftOf(role), [role]);
  const dirty =
    draft.percent !== original.percent ||
    draft.amount !== original.amount ||
    draft.permissions.size !== original.permissions.size ||
    [...draft.permissions].some((p) => !original.permissions.has(p));

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const save = useSave(
    (api, body: object, key) =>
      api.patch<RoleInfo>(`/api/v1/roles/${role.id}`, body, { idempotencyKey: key }),
    { invalidate: [KEYS.roles], onSuccess: () => toast(t('roles.saved')) },
  );

  const groups = useMemo(() => {
    const byModule = new Map<string, PermissionInfo[]>();
    for (const p of props.permissions) {
      byModule.set(p.module, [...(byModule.get(p.module) ?? []), p]);
    }
    const rank = (module: string) => {
      const index = MODULE_ORDER.indexOf(module);
      return index < 0 ? MODULE_ORDER.length : index;
    };
    return [...byModule.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  }, [props.permissions]);

  const toggle = (code: string, on: boolean) =>
    setDraft((d) => {
      const permissions = new Set(d.permissions);
      if (on) permissions.add(code);
      else permissions.delete(code);
      return { ...d, permissions };
    });

  const submit = () => {
    let maxDiscountBp: bigint;
    let maxDiscountFils: bigint;
    try {
      maxDiscountBp = parseScaled(draft.percent, 2);
      maxDiscountFils = parseFils(draft.amount);
    } catch {
      return setError(t('roles.discountInvalid'));
    }
    if (maxDiscountBp < 0n || maxDiscountBp > 10_000n || maxDiscountFils < 0n) {
      return setError(t('roles.discountInvalid'));
    }
    setError(null);
    save.mutate(
      {
        permissions: [...draft.permissions].sort(),
        maxDiscountBp: Number(maxDiscountBp),
        maxDiscountFils: maxDiscountFils.toString(),
      },
      { onError: (caught) => setError(errorText(caught)) },
    );
  };

  const sells = SELLING.some((code) => draft.permissions.has(code));
  const name = nameOf({ displayNameAr: role.nameAr, displayNameEn: role.nameEn });

  return (
    <Card rise index={3}>
      <div className={styles.cardHead}>
        <h2>{t('roles.permissionsOf', { name })}</h2>
        <Chip>{t('roles.users', { count: role.activeUsers })}</Chip>
      </div>
      {isOwnerRole && <Note>{t('roles.ownerLocked')}</Note>}
      {!isOwnerRole &&
        groups.map(([module, permissions]) => (
          <div key={module} role="group" aria-label={t(`roles.modules.${module}`, module)}>
            <div className={styles.grp}>{t(`roles.modules.${module}`, module)}</div>
            {permissions.map((p) => {
              const blockedForRole = p.ownerOnly;
              return (
                <Switch
                  key={p.code}
                  className={styles.tg}
                  isSelected={draft.permissions.has(p.code)}
                  isDisabled={!editable || blockedForRole}
                  onChange={(on) => toggle(p.code, on)}
                >
                  <span className={styles.tgText}>
                    {nameOf({ displayNameAr: p.nameAr, displayNameEn: p.nameEn })}
                    {(p.ownerOnly || p.approvable) && (
                      <span className={styles.small}>
                        {p.ownerOnly ? t('roles.ownerOnly') : t('roles.approvable')}
                      </span>
                    )}
                  </span>
                </Switch>
              );
            })}
          </div>
        ))}
      {sells && !isOwnerRole && (
        <div className={styles.limRow}>
          <span>{t('roles.discount')}</span>
          <span className={styles.lim}>
            <TextField
              label={t('roles.discountPercent')}
              value={draft.percent}
              onChange={(percent) => setDraft((d) => ({ ...d, percent }))}
              ltr
              inputMode="numeric"
              isDisabled={!editable}
            />
            <TextField
              label={t('roles.discountAmount')}
              value={draft.amount}
              onChange={(amount) => setDraft((d) => ({ ...d, amount }))}
              ltr
              inputMode="numeric"
              isDisabled={!editable}
            />
          </span>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      <Note className={styles.tableNote}>{t('roles.serverChecks')}</Note>
      {editable && (
        <div className={styles.savebar}>
          <span className={styles.dirty}>{dirty ? t('roles.unsaved') : ''}</span>
          <div className={styles.tools}>
            <Button
              isDisabled={!dirty}
              onPress={() => {
                setDraft(draftOf(role));
                setError(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              isDisabled={!dirty || save.isPending}
              busy={save.isPending}
              onPress={submit}
            >
              {t('roles.savePermissions')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
