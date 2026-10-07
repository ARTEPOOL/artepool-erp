import arAuth from '../locales/ar/auth.json';
import arCommon from '../locales/ar/common.json';
import arSettings from '../locales/ar/settings.json';
import arShell from '../locales/ar/shell.json';
import enAuth from '../locales/en/auth.json';
import enCommon from '../locales/en/common.json';
import enSettings from '../locales/en/settings.json';
import enShell from '../locales/en/shell.json';

export const LANGUAGES = ['ar', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'ar';
export const DIRECTION: Readonly<Record<Language, 'rtl' | 'ltr'>> = { ar: 'rtl', en: 'ltr' };

/** Translation resources, one namespace per JSON file under locales/<language>/. */
export const resources = {
  ar: { common: arCommon, shell: arShell, auth: arAuth, settings: arSettings },
  en: { common: enCommon, shell: enShell, auth: enAuth, settings: enSettings },
} as const;

export const NAMESPACES = Object.keys(resources.ar) as (keyof (typeof resources)['ar'])[];
