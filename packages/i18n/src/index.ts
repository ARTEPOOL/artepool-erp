import arAccounting from '../locales/ar/accounting.json';
import arAuth from '../locales/ar/auth.json';
import arCommon from '../locales/ar/common.json';
import arItems from '../locales/ar/items.json';
import arMasterdata from '../locales/ar/masterdata.json';
import arParties from '../locales/ar/parties.json';
import arSettings from '../locales/ar/settings.json';
import arShell from '../locales/ar/shell.json';
import enAccounting from '../locales/en/accounting.json';
import enAuth from '../locales/en/auth.json';
import enCommon from '../locales/en/common.json';
import enItems from '../locales/en/items.json';
import enMasterdata from '../locales/en/masterdata.json';
import enParties from '../locales/en/parties.json';
import enSettings from '../locales/en/settings.json';
import enShell from '../locales/en/shell.json';

export const LANGUAGES = ['ar', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'ar';
export const DIRECTION: Readonly<Record<Language, 'rtl' | 'ltr'>> = { ar: 'rtl', en: 'ltr' };

/** Translation resources, one namespace per JSON file under locales/<language>/. */
export const resources = {
  ar: {
    common: arCommon,
    shell: arShell,
    auth: arAuth,
    settings: arSettings,
    masterdata: arMasterdata,
    items: arItems,
    parties: arParties,
    accounting: arAccounting,
  },
  en: {
    common: enCommon,
    shell: enShell,
    auth: enAuth,
    settings: enSettings,
    masterdata: enMasterdata,
    items: enItems,
    parties: enParties,
    accounting: enAccounting,
  },
} as const;

export const NAMESPACES = Object.keys(resources.ar) as (keyof (typeof resources)['ar'])[];
