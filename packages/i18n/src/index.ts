import arAccounting from '../locales/ar/accounting.json';
import arAuth from '../locales/ar/auth.json';
import arCommon from '../locales/ar/common.json';
import arInventory from '../locales/ar/inventory.json';
import arItems from '../locales/ar/items.json';
import arLists from '../locales/ar/lists.json';
import arMasterdata from '../locales/ar/masterdata.json';
import arParties from '../locales/ar/parties.json';
import arSettings from '../locales/ar/settings.json';
import arSetup from '../locales/ar/setup.json';
import arFirstRun from '../locales/ar/firstRun.json';
import arShell from '../locales/ar/shell.json';
import arReceipts from '../locales/ar/receipts.json';
import arPos from '../locales/ar/pos.json';
import arQuotations from '../locales/ar/quotations.json';
import arInvoices from '../locales/ar/invoices.json';
import arSales from '../locales/ar/sales.json';
import arEmergency from '../locales/ar/emergency.json';
import enAccounting from '../locales/en/accounting.json';
import enAuth from '../locales/en/auth.json';
import enCommon from '../locales/en/common.json';
import enInventory from '../locales/en/inventory.json';
import enItems from '../locales/en/items.json';
import enLists from '../locales/en/lists.json';
import enMasterdata from '../locales/en/masterdata.json';
import enParties from '../locales/en/parties.json';
import enSettings from '../locales/en/settings.json';
import enSetup from '../locales/en/setup.json';
import enFirstRun from '../locales/en/firstRun.json';
import enShell from '../locales/en/shell.json';
import enReceipts from '../locales/en/receipts.json';
import enPos from '../locales/en/pos.json';
import enQuotations from '../locales/en/quotations.json';
import enInvoices from '../locales/en/invoices.json';
import enSales from '../locales/en/sales.json';
import enEmergency from '../locales/en/emergency.json';

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
    setup: arSetup,
    firstRun: arFirstRun,
    lists: arLists,
    inventory: arInventory,
    sales: arSales,
    invoices: arInvoices,
    quotations: arQuotations,
    receipts: arReceipts,
    pos: arPos,
    emergency: arEmergency,
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
    setup: enSetup,
    firstRun: enFirstRun,
    lists: enLists,
    inventory: enInventory,
    sales: enSales,
    invoices: enInvoices,
    quotations: enQuotations,
    receipts: enReceipts,
    pos: enPos,
    emergency: enEmergency,
  },
} as const;

export const NAMESPACES = Object.keys(resources.ar) as (keyof (typeof resources)['ar'])[];
