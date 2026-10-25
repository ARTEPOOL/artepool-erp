/**
 * The first-run wizard on the server PC (decisions 0092, 0102), against a scripted server: it
 * opens by itself only when the setup token is on this PC and setup is not complete; it walks the
 * owner through company → account → phone 2-step → recovery codes → this PC as the POS → finish,
 * every step through the setup channel; closing the app halfway picks up where it stopped; a
 * refused password says why.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CompanyProfile, SetupStatusResponse } from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { failure, FakeBridge, ok, POS } from '../support/fake-bridge';

const status = (patch: Partial<SetupStatusResponse> = {}): SetupStatusResponse => ({
  state: 'not_started',
  path: null,
  company: null,
  owner: null,
  posDevice: null,
  ...patch,
});

const COMPANY = {
  legalNameAr: 'آرتيبول',
  legalNameEn: 'ARTEPOOL',
  rowVersion: 1,
} as unknown as CompanyProfile;

const OWNER = {
  username: 'mohammed',
  displayNameAr: 'محمد ياسر',
  displayNameEn: 'Mohammed Yasser',
  twoStepEnabled: false,
};

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function serverPc(): FakeBridge {
  const bridge = new FakeBridge(null);
  bridge.setup = { available: true, serverAddress: '127.0.0.1:3100', windowsBuild: null };
  return bridge;
}

describe('the first-run wizard', () => {
  it('does not show on a PC without the setup token', async () => {
    const bridge = new FakeBridge(null);
    render(<App bridge={bridge} />);
    await screen.findByRole('heading', { name: 'تسجيل هذا الجهاز' });
    expect(bridge.setupCalls).toEqual([]);
  });

  it('does not show once setup is complete (the normal screens follow)', async () => {
    const bridge = serverPc().on('GET', '/api/v1/setup/status', ok(status({ state: 'complete' })));
    render(<App bridge={bridge} />);
    await screen.findByRole('heading', { name: 'تسجيل هذا الجهاز' });
  });

  it('a full "New setup": company, account, phone code, recovery codes, this PC, finish', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `AAAA${i}-BBBBB`);
    const bridge = serverPc()
      .on('GET', '/api/v1/setup/status', ok(status()))
      .on('POST', '/api/v1/setup/start', ok(status({ state: 'in_progress', path: 'new' })))
      .on('PUT', '/api/v1/setup/company', ok(COMPANY))
      .on(
        'POST',
        '/api/v1/setup/owner',
        failure(422, 'PASSWORD_REJECTED', { problems: ['common'], minLength: 10 }),
        ok(status({ state: 'in_progress', path: 'new', company: COMPANY, owner: OWNER })),
      )
      .on(
        'POST',
        '/api/v1/setup/two-step/start',
        ok({
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          uri: 'otpauth://totp/ARTEPOOL:mohammed?secret=JBSWY3DPEHPK3PXP',
        }),
      )
      .on('POST', '/api/v1/setup/two-step/confirm', ok({ recoveryCodes: codes }))
      .on('POST', '/api/v1/setup/device-code', ok({ code: 'ABCD-EFGH', expiresAt: '2026-10-22' }))
      .on('POST', '/api/v1/setup/complete', ok({ state: 'complete' }));
    bridge.enrollOutcome = { ok: true, serverUrl: 'https://127.0.0.1:3100', device: POS };
    render(<App bridge={bridge} />);

    // Two paths: a new setup, or a restore from a backup.
    await screen.findByRole('heading', { name: 'أهلًا بيك في آرتيبول' });
    expect(screen.getByRole('button', { name: 'استرجع من نسخة احتياطية' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ابدأ' }));

    // 1. Company: checked here first, then saved.
    await screen.findByText('الخطوة 1 من 5: بيانات الشركة');
    fireEvent.click(screen.getByRole('button', { name: 'احفظ وكمّل' }));
    expect((await screen.findAllByText('إلزامي.')).length).toBeGreaterThan(0);
    expect(bridge.setupCalls.filter((c) => c.method === 'PUT')).toEqual([]);
    type('الاسم القانوني بالعربية *', 'آرتيبول');
    type('الاسم القانوني بالإنجليزية *', 'ARTEPOOL');
    type('العنوان بالعربية *', 'العين');
    type('العنوان بالإنجليزية *', 'Al Ain');
    fireEvent.click(screen.getByRole('button', { name: 'احفظ وكمّل' }));

    // 2. The owner: a common password is refused with the reason.
    await screen.findByText('الخطوة 2 من 5: حسابك');
    type('اسم الدخول', 'Mohammed');
    type('الاسم بالعربي', 'محمد ياسر');
    type('الاسم بالإنجليزي', 'Mohammed Yasser');
    type('كلمة السر', '1234567890');
    type('اكتب كلمة السر تاني', '1234567890');
    fireEvent.click(screen.getByRole('button', { name: 'اعمل الحساب وكمّل' }));
    expect(await screen.findByText('كلمة المرور هذه شائعة جدًا.')).toBeTruthy();
    type('كلمة السر', 'blue-pool-water-71');
    type('اكتب كلمة السر تاني', 'blue-pool-water-71');
    fireEvent.click(screen.getByRole('button', { name: 'اعمل الحساب وكمّل' }));

    // 3. Phone code, 4. recovery codes (shown once, Continue needs the tick).
    await screen.findByText('الخطوة 3 من 5: كود الموبايل');
    expect(await screen.findByRole('img', { name: 'رمز QR لتطبيق المصادقة' })).toBeTruthy();
    fireEvent.paste(screen.getByLabelText('رقم 1'), { clipboardData: { getData: () => '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }));
    await screen.findByText('الخطوة 4 من 5: أكواد الاسترجاع');
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(10);
    fireEvent.click(screen.getByRole('checkbox', { name: 'طبعت هذه الرموز أو كتبتها' }));
    fireEvent.click(screen.getByRole('button', { name: 'متابعة' }));

    // 5. This PC, enrolled as the POS with a one-time code from the setup channel.
    await screen.findByText('الخطوة 5 من 5: الجهاز ده');
    expect(screen.queryByText(codes[0]!)).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('اسم الجهاز').value).toBe('الكاشير والسيرفر');
    type('رمز الجهاز', 'pos-01');
    fireEvent.click(screen.getByRole('button', { name: 'سجّل الجهاز ده وكمّل' }));
    await screen.findByRole('heading', { name: 'باقي خطوة واحدة' });
    expect(bridge.enrollCalls).toEqual([
      {
        serverAddress: '127.0.0.1:3100',
        code: 'ABCD-EFGH',
        deviceCode: 'POS-01',
        deviceName: 'الكاشير والسيرفر',
        deviceKind: 'pos',
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'خلّص الإعداد' }));
    await screen.findByRole('heading', { name: 'الإعداد خلص' });

    // Every step went through the setup channel, none through the normal one.
    expect(bridge.setupCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/setup/status',
      'POST /api/v1/setup/start',
      'PUT /api/v1/setup/company',
      'POST /api/v1/setup/owner',
      'POST /api/v1/setup/owner',
      'POST /api/v1/setup/two-step/start',
      'POST /api/v1/setup/two-step/confirm',
      'POST /api/v1/setup/device-code',
      'POST /api/v1/setup/complete',
    ]);
    expect(bridge.setupCalls[3]!.body).toMatchObject({ username: 'mohammed' });
    // The normal channel: only the kiosk state, asked once this PC is a POS PC.
    expect(new Set(bridge.calls.map((c) => c.path))).toEqual(new Set(['/api/v1/kiosk/state']));

    // The token is gone now: on to the normal sign-in on this (now enrolled) PC.
    bridge.setup = { available: false, serverAddress: null, windowsBuild: null };
    bridge.local = {
      enrolled: true,
      serverUrl: 'https://127.0.0.1:3100',
      device: POS,
      suggestedCode: 'POS-01',
    };
    bridge
      .on('GET', '/api/v1/devices/me', ok({ device: POS, keyExpiresAt: '2027-10-07' }))
      .on('GET', '/api/v1/auth/pin-users', ok({ pinAllowed: true, users: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'روح لشاشة الدخول' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'الإعداد خلص' })).toBeNull());
  });

  it('warns on Windows 10 that it no longer gets free security updates, without blocking (0106)', async () => {
    const windows10 = serverPc()
      .on('GET', '/api/v1/setup/status', ok(status()))
      .on('POST', '/api/v1/setup/start', ok(status({ state: 'in_progress', path: 'new' })));
    windows10.setup = { ...windows10.setup, windowsBuild: 19045 };
    render(<App bridge={windows10} />);
    expect(await screen.findByText(/الجهاز ده عليه Windows 10/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ابدأ' }));
    await screen.findByText('الخطوة 1 من 5: بيانات الشركة');
  });

  it('shows no warning on Windows 11', async () => {
    const windows11 = serverPc().on('GET', '/api/v1/setup/status', ok(status()));
    windows11.setup = { ...windows11.setup, windowsBuild: 22631 };
    render(<App bridge={windows11} />);
    await screen.findByRole('heading', { name: 'أهلًا بيك في آرتيبول' });
    expect(screen.queryByText(/الجهاز ده عليه Windows 10/)).toBeNull();
  });

  it('picks up where it stopped after the app was closed', async () => {
    const bridge = serverPc().on(
      'GET',
      '/api/v1/setup/status',
      ok(status({ state: 'in_progress', path: 'new', company: COMPANY, owner: OWNER })),
    );
    bridge.on(
      'POST',
      '/api/v1/setup/two-step/start',
      ok({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/ARTEPOOL:mohammed?secret=X' }),
    );
    render(<App bridge={bridge} />);
    await screen.findByText('الخطوة 3 من 5: كود الموبايل');

    const done = serverPc().on(
      'GET',
      '/api/v1/setup/status',
      ok(
        status({
          state: 'in_progress',
          path: 'new',
          company: COMPANY,
          owner: { ...OWNER, twoStepEnabled: true },
          posDevice: { code: 'POS-01', name: 'الكاشير والسيرفر' },
        }),
      ),
    );
    render(<App bridge={done} />);
    expect(await screen.findByRole('heading', { name: 'باقي خطوة واحدة' })).toBeTruthy();
  });
});
