import { Moon, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, type Language } from '@artepool/i18n';
import { setLanguage } from '../i18n';
import { useTheme } from '../theme/theme';
import { IconButton, iconClass } from '../ui';
import styles from './TopTools.module.css';

/** AR / EN switch (the design's `.lang`); the layout mirrors at once. */
export function LanguageSwitch() {
  const { t, i18n } = useTranslation('shell');
  return (
    <div role="group" aria-label={t('language.label')} className={styles.lang}>
      {LANGUAGES.map((lang: Language) => (
        <button
          key={lang}
          type="button"
          lang={lang}
          aria-pressed={i18n.language === lang}
          aria-label={t(`language.${lang}Name`)}
          onClick={() => void setLanguage(lang)}
        >
          {t(`language.${lang}`)}
        </button>
      ))}
    </div>
  );
}

/** Sun in light mode, moon in dark mode (the design's theme button). */
export function ThemeToggle() {
  const { t } = useTranslation('shell');
  const [dark, toggle] = useTheme();
  return (
    <IconButton aria-label={t('theme.toggle')} onPress={toggle} data-theme-toggle="">
      {dark ? (
        <Moon className={iconClass.md} aria-hidden="true" />
      ) : (
        <Sun className={iconClass.md} aria-hidden="true" />
      )}
    </IconButton>
  );
}

export function TopTools({ children }: { children?: React.ReactNode }) {
  return (
    <div className={styles.tools}>
      <LanguageSwitch />
      <ThemeToggle />
      {children}
    </div>
  );
}
