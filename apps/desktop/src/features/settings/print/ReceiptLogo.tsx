/**
 * Print designer → Thermal receipt → its own logo (decision 0075), separate from the company logo
 * that every A4 document prints. Empty = the receipt prints the company logo. The thermal printer
 * prints in black and white, so a simple, high-contrast logo prints best. Owner only.
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import type {
  LogoType,
  ReceiptLogoResponse,
  SaveReceiptLogoRequest,
} from '@artepool/shared/contracts';
import { useApi, useSave } from '../../../api/hooks';
import { Alert, Button, iconClass, Note, useToast } from '../../../ui';
import { useErrorText } from '../../auth/context';
import { readAsBase64 } from '../../masterdata/files';
import { RECEIPT_LOGO_KEY } from '../../pos/receipt/logo';
import { logoFileProblem } from '../company/LogoCard';
import companyStyles from '../company/company.module.css';

export function ReceiptLogo({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation('settings');
  const tSetup = useTranslation('setup').t;
  const api = useApi();
  const toast = useToast();
  const errorText = useErrorText();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const current = useQuery({
    queryKey: RECEIPT_LOGO_KEY,
    queryFn: () => api.get<ReceiptLogoResponse>('/api/v1/print-templates/receipt-logo'),
  });
  const save = useSave(
    (client, body: SaveReceiptLogoRequest, key) =>
      client.put<ReceiptLogoResponse>('/api/v1/print-templates/receipt-logo', body, {
        idempotencyKey: key,
      }),
    {
      invalidate: [RECEIPT_LOGO_KEY, ['print']],
      onSuccess: (_, body) =>
        toast(body.logo ? t('print.receiptLogo.uploaded') : t('print.receiptLogo.removed')),
    },
  );
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setProblem(null);
    if (!file) return;
    const refused = logoFileProblem(file);
    if (refused) return setProblem(tSetup(`company.logo.${refused}`));
    save.mutate(
      { logo: { type: file.type as LogoType, dataBase64: await readAsBase64(file) } },
      { onError: (e) => setProblem(errorText(e)) },
    );
  };
  const data = current.data;
  return (
    <div>
      <p>
        <b>{t('print.receiptLogo.title')}</b>
      </p>
      <div className={companyStyles.logoRow}>
        {data?.logo && (
          <img
            className={companyStyles.logo}
            src={`data:${data.logo.type};base64,${data.logo.dataBase64}`}
            alt={t('print.receiptLogo.alt')}
          />
        )}
        <Note>{data?.own ? t('print.receiptLogo.own') : t('print.receiptLogo.company')}</Note>
        {canEdit && (
          <div className={companyStyles.logoActions}>
            <input
              ref={input}
              type="file"
              accept=".png,.jpg,.jpeg,image/png,image/jpeg"
              aria-label={t('print.receiptLogo.upload')}
              className={companyStyles.hiddenInput}
              tabIndex={-1}
              disabled={save.isPending}
              onChange={(event) => void choose(event)}
            />
            <Button
              busy={save.isPending}
              isDisabled={save.isPending}
              onPress={() => input.current?.click()}
            >
              <Upload className={iconClass.sm} aria-hidden="true" />
              {t('print.receiptLogo.upload')}
            </Button>
            {data?.own && (
              <Button
                variant="dangerGhost"
                isDisabled={save.isPending}
                onPress={() => {
                  setProblem(null);
                  save.mutate({ logo: null }, { onError: (e) => setProblem(errorText(e)) });
                }}
              >
                <Trash2 className={iconClass.sm} aria-hidden="true" />
                {t('print.receiptLogo.useCompany')}
              </Button>
            )}
          </div>
        )}
      </div>
      <Note>{t('print.receiptLogo.hint')}</Note>
      {problem && <Alert>{problem}</Alert>}
    </div>
  );
}
