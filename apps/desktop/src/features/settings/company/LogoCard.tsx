import { useRef, useState, type ChangeEvent } from 'react';
import { ImageOff, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  type CompanyProfile,
  type LogoResponse,
  type LogoType,
  type SaveLogoRequest,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { Alert, Button, iconClass, Note, useToast } from '../../../ui';
import { MD_KEYS } from '../../masterdata/refs';
import { readAsBase64 } from '../../masterdata/files';
import { CardHead, Section } from '../parts';
import styles from './company.module.css';
import { SaveProblem } from './SaveProblem';

/** Why a chosen file is refused before anything is sent (decision 0037), or null if it is fine. */
export function logoFileProblem(file: File): 'type' | 'size' | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'type';
  if (!/\.(png|jpe?g)$/i.test(file.name)) return 'type';
  if (file.size > LOGO_MAX_BYTES) return 'size';
  return null;
}

/**
 * Design 13 → Company → "Logo": PNG or JPEG up to 512 KB, never SVG (an SVG file can carry hidden
 * code). The server checks the file's content again. A new logo appears on new printouts only.
 */
export function LogoCard({
  company,
  canEdit,
}: {
  company: CompanyProfile | null;
  canEdit: boolean;
}) {
  const { t } = useTranslation('setup');
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const logo = useQuery({
    queryKey: MD_KEYS.logo,
    queryFn: () => api.get<LogoResponse>('/api/v1/company/logo'),
  });
  const save = useSave(
    (client, body: SaveLogoRequest, key) =>
      client.put('/api/v1/company/logo', body, { idempotencyKey: key }),
    {
      invalidate: [MD_KEYS.logo, MD_KEYS.company],
      onSuccess: (_, body) =>
        toast(body.logo ? t('company.logo.uploaded') : t('company.logo.removed')),
    },
  );

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setProblem(null);
    setError(null);
    if (!file || !company) return;
    const refused = logoFileProblem(file);
    if (refused) return setProblem(t(`company.logo.${refused}`));
    const dataBase64 = await readAsBase64(file);
    save.mutate(
      { logo: { type: file.type as LogoType, dataBase64 }, rowVersion: company.rowVersion },
      { onError: setError },
    );
  };

  const current = logo.data?.logo ?? null;
  return (
    <Section index={2}>
      <CardHead title={t('company.logo.title')} />
      <div className={styles.logoRow}>
        {current ? (
          <img
            className={styles.logo}
            src={`data:${current.type};base64,${current.dataBase64}`}
            alt={t('company.logo.alt')}
          />
        ) : (
          <span className={styles.noLogo}>
            <ImageOff aria-hidden="true" />
            {t('company.logo.none')}
          </span>
        )}
        {canEdit && (
          <div className={styles.logoActions}>
            <input
              ref={input}
              type="file"
              accept=".png,.jpg,.jpeg,image/png,image/jpeg"
              aria-label={t('company.logo.upload')}
              className={styles.hiddenInput}
              tabIndex={-1}
              disabled={!company || save.isPending}
              onChange={(event) => void choose(event)}
            />
            <Button
              isDisabled={!company || save.isPending}
              busy={save.isPending}
              onPress={() => input.current?.click()}
            >
              <Upload className={iconClass.sm} aria-hidden="true" />
              {t('company.logo.upload')}
            </Button>
            {current && (
              <Button
                variant="dangerGhost"
                isDisabled={!company || save.isPending}
                onPress={() => {
                  setProblem(null);
                  setError(null);
                  if (company) {
                    save.mutate(
                      { logo: null, rowVersion: company.rowVersion },
                      { onError: setError },
                    );
                  }
                }}
              >
                <Trash2 className={iconClass.sm} aria-hidden="true" />
                {t('company.logo.remove')}
              </Button>
            )}
          </div>
        )}
      </div>
      {problem && <Alert>{problem}</Alert>}
      <SaveProblem
        error={error}
        onReload={() => {
          setError(null);
          void queryClient.invalidateQueries({ queryKey: MD_KEYS.company });
        }}
      />
      <Note className={styles.logoNote}>
        {company || !canEdit ? t('company.logo.rules') : t('company.logo.saveFirst')}
      </Note>
    </Section>
  );
}
