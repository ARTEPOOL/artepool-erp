/**
 * Settings → Lists → Warehouses: store, site or van (a van belongs to a technician). Exactly one
 * warehouse is the default; choosing another moves the mark (a database rule).
 */
import { useState } from 'react';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  WAREHOUSE_TYPES,
  type WarehouseItem,
  type WarehouseType,
} from '@artepool/shared/contracts';
import { Button, Chip, iconClass, Note, SelectField, useToast } from '../../../ui';
import { useCan } from '../../auth/context';
import { localName, MD_KEYS } from '../../masterdata/refs';
import { useSave } from '../api';
import { ListEditor } from './ListEditor';
import { FieldMessage, listClasses as styles, SaveError } from './parts';
import { useTechnicians, useWarehouses } from './queries';

type WarehouseForm = {
  code: string;
  nameAr: string;
  nameEn: string;
  warehouseType: WarehouseType;
  technicianId: string;
};

export function WarehousesTab() {
  const { t, i18n } = useTranslation('lists');
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const nameOf = localName(i18n.language);
  const warehouses = useWarehouses();
  const seesTechnicians = can('technicians.manage');
  const technicians = useTechnicians(seesTechnicians);
  const techList = technicians.data ?? [];
  const [error, setError] = useState<unknown>(null);

  const makeDefault = useSave(
    (api, row: WarehouseItem, key) =>
      api.post(
        `/api/v1/warehouses/${row.id}/make-default`,
        { rowVersion: row.rowVersion },
        { idempotencyKey: key },
      ),
    {
      invalidate: [MD_KEYS.warehouses],
      onSuccess: (_, row) => toast(t('warehouses.defaultMoved', { name: nameOf(row) })),
    },
  );

  const technicianName = (id: string | null) => {
    if (!id) return t('masterdata:none');
    const tech = techList.find((x) => x.id === id);
    return tech ? nameOf(tech) : t('warehouses.technicianHidden');
  };

  return (
    <>
      <SaveError
        error={error}
        onReload={() => {
          setError(null);
          void queryClient.invalidateQueries({ queryKey: MD_KEYS.warehouses });
        }}
      />
      <ListEditor<WarehouseItem, WarehouseForm>
        section="warehouses"
        basePath="/api/v1/warehouses"
        queryKey={MD_KEYS.warehouses}
        query={warehouses}
        canEdit={can('warehouses.manage')}
        codeFixed
        columns={[
          {
            id: 'type',
            header: t('warehouses.type'),
            cell: (w) => t(`warehouses.types.${w.warehouseType}`),
          },
          {
            id: 'technician',
            header: t('warehouses.technician'),
            cell: (w) => technicianName(w.technicianId),
          },
          {
            id: 'default',
            header: t('warehouses.default'),
            cell: (w) =>
              w.isDefault ? (
                <Chip tone="primary" icon={<Star aria-hidden="true" />}>
                  {t('warehouses.default')}
                </Chip>
              ) : null,
          },
        ]}
        canDeactivate={(w) => !w.isDefault}
        rowTools={(w) =>
          w.isDefault ? null : (
            <Button
              variant="ghost"
              busy={makeDefault.isPending && makeDefault.variables?.id === w.id}
              aria-label={t('warehouses.makeDefaultOf', { code: w.code })}
              onPress={() => {
                setError(null);
                makeDefault.mutate(w, { onError: setError });
              }}
            >
              <Star className={iconClass.sm} aria-hidden="true" />
              {t('warehouses.makeDefault')}
            </Button>
          )
        }
        toForm={(w) => ({
          code: w?.code ?? '',
          nameAr: w?.nameAr ?? '',
          nameEn: w?.nameEn ?? '',
          warehouseType: w?.warehouseType ?? 'store',
          technicianId: w?.technicianId ?? '',
        })}
        toBody={(form) => ({
          warehouseType: form.warehouseType,
          technicianId: form.warehouseType === 'van' ? form.technicianId || null : null,
        })}
        check={(form): Record<string, string> =>
          form.warehouseType === 'van' && !form.technicianId
            ? { technicianId: t('warehouses.vanNeedsTechnician') }
            : {}
        }
        fieldNames={['warehouseType', 'technicianId']}
        fields={({ form, set, error: fieldError }) => (
          <div className={styles.grid2}>
            <SelectField
              id="warehouse-type"
              label={t('warehouses.type')}
              value={form.warehouseType}
              onChange={(value) => set({ warehouseType: value as WarehouseType })}
              options={WAREHOUSE_TYPES.map((value) => ({
                value,
                label: t(`warehouses.types.${value}`),
              }))}
            />
            {form.warehouseType === 'van' && (
              <div className={styles.form}>
                {seesTechnicians ? (
                  <SelectField
                    id="warehouse-technician"
                    label={t('warehouses.technician')}
                    value={form.technicianId}
                    onChange={(technicianId) => set({ technicianId })}
                    options={[
                      { value: '', label: t('choose') },
                      ...techList
                        .filter((x) => x.isActive || x.id === form.technicianId)
                        .map((x) => ({ value: x.id, label: `${x.code} · ${nameOf(x)}` })),
                    ]}
                  />
                ) : (
                  <Note>{t('warehouses.techniciansNeedPermission')}</Note>
                )}
                <FieldMessage text={fieldError('technicianId')} />
              </div>
            )}
          </div>
        )}
        note={<Note>{t('warehouses.note')}</Note>}
      />
    </>
  );
}
