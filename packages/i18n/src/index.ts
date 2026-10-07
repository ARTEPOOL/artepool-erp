import arCommon from '../locales/ar/common.json';
import enCommon from '../locales/en/common.json';

export const LANGUAGES = ['ar', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'ar';
export const DIRECTION: Readonly<Record<Language, 'rtl' | 'ltr'>> = { ar: 'rtl', en: 'ltr' };

/** Translation resources, one namespace per JSON file under locales/<language>/. */
export const resources = {
  ar: { common: arCommon },
  en: { common: enCommon },
} as const;
