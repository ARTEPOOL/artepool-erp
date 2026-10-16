/**
 * The company logo as an image the receipt can draw (the receipt template's "Logo" field,
 * decision 0064). Loaded once from Settings → Company and kept while the app runs.
 */
import { useQuery } from '@tanstack/react-query';
import type { LogoResponse } from '@artepool/shared/contracts';
import { useApi } from '../../../api/hooks';
import { MD_KEYS } from '../../masterdata/refs';

function decode(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

export function useReceiptLogo(): HTMLImageElement | null {
  const api = useApi();
  const logo = useQuery({
    queryKey: [...MD_KEYS.logo, 'image'],
    queryFn: async () => {
      const { logo: file } = await api.get<LogoResponse>('/api/v1/company/logo');
      return file ? decode(`data:${file.type};base64,${file.dataBase64}`) : null;
    },
    staleTime: Infinity,
  });
  return logo.data ?? null;
}
