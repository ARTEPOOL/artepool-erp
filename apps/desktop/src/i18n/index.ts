import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  DEFAULT_LANGUAGE,
  DIRECTION,
  LANGUAGES,
  NAMESPACES,
  resources,
  type Language,
} from '@artepool/i18n';

const STORAGE_KEY = 'artepool.language';

/** The language chosen on this PC (a UI preference, the only kind of data a PC keeps). */
export function savedLanguage(): Language {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return LANGUAGES.includes(value as Language) ? (value as Language) : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/** Sets lang and dir on the page: Arabic right-to-left, English left-to-right. */
export function applyDirection(language: string): void {
  const lang: Language = LANGUAGES.includes(language as Language)
    ? (language as Language)
    : DEFAULT_LANGUAGE;
  document.documentElement.lang = lang;
  document.documentElement.dir = DIRECTION[lang];
}

export async function initI18n(language: Language = savedLanguage()): Promise<typeof i18n> {
  if (!i18n.isInitialized) {
    i18n.on('languageChanged', applyDirection);
    await i18n.use(initReactI18next).init({
      resources,
      lng: language,
      fallbackLng: false,
      ns: NAMESPACES,
      defaultNS: 'common',
      // Messages use {name} placeholders (checked by `pnpm i18n:check`).
      interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
      returnNull: false,
    });
  } else {
    await i18n.changeLanguage(language);
  }
  applyDirection(language);
  return i18n;
}

export async function setLanguage(language: Language): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Private mode or blocked storage: the choice simply is not remembered.
  }
  await i18n.changeLanguage(language);
}

export { i18n };
