/** T8: the desktop foundation — design tokens, Arabic/English with RTL/LTR, light/dark. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoginFrame } from '../../src/app/LoginFrame';
import { i18n } from '../../src/i18n';
import { Alert, Button, Chip, Note, ToastProvider, useToast } from '../../src/ui';

const repo = join(import.meta.dirname, '..', '..', '..', '..');

describe('design tokens', () => {
  it('are exactly the approved design tokens', () => {
    expect(readFileSync(join(repo, 'apps/desktop/src/theme/tokens.css'), 'utf8')).toBe(
      readFileSync(join(repo, 'design/artepool-tokens.css'), 'utf8'),
    );
  });
});

describe('the login frame', () => {
  it('starts in Arabic, right to left, and mirrors to English, left to right', async () => {
    render(<LoginFrame />);
    expect(document.documentElement).toMatchObject({ lang: 'ar', dir: 'rtl' });
    expect(screen.getByText('ARTÉPOOL')).toBeTruthy();
    const group = screen.getByRole('group', { name: 'اللغة' });
    const english = screen.getByRole('button', { name: 'English' });
    expect(english.getAttribute('aria-pressed')).toBe('false');
    expect(group.contains(english)).toBe(true);
    await act(async () => {
      fireEvent.click(english);
      await Promise.resolve();
    });
    expect(document.documentElement).toMatchObject({ lang: 'en', dir: 'ltr' });
    expect(screen.getByRole('group', { name: 'Language' })).toBeTruthy();
    expect(english.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('artepool.language')).toBe('en');
  });

  it('switches between light and dark, and remembers it on this PC', () => {
    render(<LoginFrame />);
    const toggle = screen.getByRole('button', { name: 'الوضع الفاتح أو الغامق' });
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('artepool.theme')).toBe('light');
  });

  it('shows the app version in Western digits inside an isolated run', () => {
    render(<LoginFrame />);
    const version = screen.getByText(/^ARTÉPOOL ERP v\d+\.\d+\.\d+$/);
    expect(version.tagName).toBe('BDI');
  });
});

describe('UI pieces', () => {
  it('renders statuses with text and icon, never colour alone', () => {
    render(
      <Chip tone="ok" icon={<svg data-testid="icon" />}>
        {i18n.t('shell:server.connected')}
      </Chip>,
    );
    expect(
      screen.getByText('متصل بالخادم الرئيسي').parentElement?.querySelector('[data-testid=icon]'),
    ).toBeTruthy();
  });

  it('announces errors and confirmations to screen readers', () => {
    function Demo() {
      const toast = useToast();
      return (
        <Button onPress={() => toast(i18n.t('shell:server.connected'))}>
          {i18n.t('shell:close')}
        </Button>
      );
    }
    render(
      <ToastProvider>
        <Alert>{i18n.t('common:errors.INVALID_CREDENTIALS')}</Alert>
        <Note>{i18n.t('shell:device.notEnrolled')}</Note>
        <Demo />
      </ToastProvider>,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'اسم المستخدم أو كلمة المرور غير صحيح.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'إغلاق' }));
    expect(screen.getByRole('status').textContent).toContain('متصل بالخادم الرئيسي');
  });
});
