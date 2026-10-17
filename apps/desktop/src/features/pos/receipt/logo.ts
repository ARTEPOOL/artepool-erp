/**
 * The logo the thermal receipt draws (the receipt template's "Logo" field, decision 0064): its own
 * logo from Settings → Print designer if one is set, else the company logo (decision 0075).
 * Loaded once and kept while the app runs; a new one replaces it at once.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReceiptLogoResponse } from '@artepool/shared/contracts';
import { useApi } from '../../../api/hooks';

function decode(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

export const RECEIPT_LOGO_KEY = ['print', 'receipt-logo'] as const;

export function useReceiptLogo(): HTMLImageElement | null {
  const api = useApi();
  const logo = useQuery({
    queryKey: [...RECEIPT_LOGO_KEY, 'image'],
    queryFn: async () => {
      const { logo: file } = await api.get<ReceiptLogoResponse>(
        '/api/v1/print-templates/receipt-logo',
      );
      return file ? decode(`data:${file.type};base64,${file.dataBase64}`) : null;
    },
    staleTime: Infinity,
  });
  return logo.data ?? null;
}
