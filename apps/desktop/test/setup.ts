import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { initI18n } from '../src/i18n';

// The simulated browser has no canvas: say so quietly (labels are then laid out, not drawn).
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as typeof HTMLCanvasElement.prototype.getContext;
}

beforeEach(async () => {
  // Pure logic files run in plain Node (`@vitest-environment node`): no screen to reset.
  if (typeof document === 'undefined') return;
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  await initI18n('ar');
});
afterEach(() => cleanup());
