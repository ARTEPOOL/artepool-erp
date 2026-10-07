import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { initI18n } from '../src/i18n';

beforeEach(async () => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  await initI18n('ar');
});
afterEach(() => cleanup());
