import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import './theme/fonts.css';
import './theme/tokens.css';
import './theme/tokens-app.css';
import './theme/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { defaultEmergencyBridge } from './features/emergency/bridge';
import { EmergencyTool } from './features/emergency/EmergencyTool';
import { initI18n } from './i18n';
import { applyTheme } from './theme/theme';

applyTheme();
await initI18n();
// "ARTÉPOOL – Emergency tool" (decision 0107): the same app, started with `--emergency`.
const emergency = defaultEmergencyBridge();
const { emergency: emergencyWindow } = await emergency.info();
createRoot(document.getElementById('root')!).render(
  <StrictMode>{emergencyWindow ? <EmergencyTool bridge={emergency} /> : <App />}</StrictMode>,
);
