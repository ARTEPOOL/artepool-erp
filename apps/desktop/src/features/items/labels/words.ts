/** The label's fixed words in both languages, from the translations (decision 0097). */
import type { i18n as I18n } from 'i18next';
import type { LabelWords } from './layout';

export function labelWords(i18n: I18n): LabelWords {
  const ar = i18n.getFixedT('ar', 'items');
  const en = i18n.getFixedT('en', 'items');
  const both = (key: string) => ({ ar: ar(key), en: en(key) });
  return {
    currency: both('aed'),
    vat: both('labels.inclVat'),
    expiry: both('labels.expiryWord'),
    batch: both('labels.batchWord'),
  };
}
