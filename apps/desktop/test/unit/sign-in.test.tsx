/**
 * T9: the sign-in screens (design 01) against a scripted server, in Arabic and English.
 * The real server and browser are covered by the Playwright flows (apps/desktop/e2e).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { setLanguage } from '../../src/i18n';
import {
  failure,
  FakeBridge,
  ok,
  POS,
  sessionView,
  signInAnswer,
  userView,
} from '../support/fake-bridge';

const me = (session = {}, user = {}) =>
  ok({
    session: sessionView(session),
    user: userView(user),
    device: { id: '2', code: 'OFFICE-01', name: 'Owner office', kind: 'office' },
    permissions: ['sales.view'],
  });

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Opens the account menu in the top bar and picks an action. */
async function accountMenu(action: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'قائمة الحساب' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: action }));
}

async function startApp(bridge: FakeBridge) {
  render(<App bridge={bridge} />);
  await screen.findByRole('heading', { level: 1 });
}

describe('enrolling this PC (decision 0024)', () => {
  it('asks for the server and code first, then shows sign-in with this PC at the bottom', async () => {
    const bridge = new FakeBridge(null);
    await startApp(bridge);
    expect(screen.getByRole('heading', { name: 'تسجيل هذا الجهاز' })).toBeTruthy();
    expect(screen.getByText('هذا الجهاز غير مسجّل بعد')).toBeTruthy();

    type('عنوان الخادم', 'artepool-server');
    type('رمز التسجيل', 'k7q-4mx-92p');
    type('اسم الجهاز', 'كاشير المعرض');
    fireEvent.click(screen.getByRole('button', { name: 'نقطة بيع' }));
    bridge.enrollOutcome = {
      ok: true,
      serverUrl: 'https://artepool-server:3100',
      device: POS,
    };
    bridge.local = { ...bridge.local, enrolled: true, device: POS };
    bridge.on('GET', '/api/v1/devices/me', ok({ device: POS, keyExpiresAt: '2027-10-07' }));
    bridge.on('GET', '/api/v1/auth/pin-users', ok({ pinAllowed: true, users: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل هذا الجهاز' }));

    await screen.findByRole('heading', { name: 'الدخول السريع' });
    expect(bridge.enrollCalls[0]).toEqual({
      serverAddress: 'artepool-server',
      code: 'K7Q-4MX-92P',
      deviceCode: 'NEW-PC',
      deviceName: 'كاشير المعرض',
      deviceKind: 'pos',
    });
    expect(screen.getByText('Showroom counter')).toBeTruthy();
    expect(screen.getByText('COUNTER-01')).toBeTruthy();
  });

  it('explains why enrollment failed, and that a revoked PC needs a new code', async () => {
    const bridge = new FakeBridge();
    bridge.on('GET', '/api/v1/devices/me', failure(403, 'DEVICE_REVOKED'));
    await startApp(bridge);
    expect(screen.getByText(/ألغى المالك تسجيل هذا الجهاز/)).toBeTruthy();
    type('عنوان الخادم', 'artepool-server');
    type('رمز التسجيل', 'AAA-BBB-CCC');
    type('اسم الجهاز', 'Office');
    bridge.enrollOutcome = { ok: false, reason: 'not_genuine' };
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل هذا الجهاز' }));
    expect(await screen.findByText(/الرمز غير صحيح أو انتهت صلاحيته، أو أن الخادم/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('رمز التسجيل').value).toBe('');
  });
});

describe('password sign-in (design 01)', () => {
  it('signs in and opens the app; the token stays in memory only', async () => {
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer()))
      .on('GET', '/api/v1/auth/me', me());
    await startApp(bridge);
    expect(screen.queryByRole('group', { name: 'طريقة الدخول' })).toBeNull(); // office PC: no PIN
    type('اسم المستخدم', 'sara.office');
    type('كلمة المرور', 'blue-pool-water');
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    await screen.findByRole('heading', { name: 'أهلًا، سارة علي' });
    expect(bridge.callsTo('POST', '/api/v1/auth/sign-in')[0]?.body).toEqual({
      username: 'sara.office',
      password: 'blue-pool-water',
    });
    expect(bridge.callsTo('GET', '/api/v1/auth/me')[0]?.token).toBe('token-1');
    expect(JSON.stringify(localStorage)).not.toContain('token-1');
    expect(JSON.stringify(localStorage)).not.toContain('blue-pool-water');
    expect(localStorage.getItem('artepool.username')).toBe('sara.office');
  });

  it('shows the design messages: missing fields, wrong password, account locked', async () => {
    const bridge = new FakeBridge().on(
      'POST',
      '/api/v1/auth/sign-in',
      failure(401, 'INVALID_CREDENTIALS'),
      failure(423, 'ACCOUNT_LOCKED', { minutes: 15 }),
    );
    await startApp(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    expect(await screen.findByText('اكتب اسم المستخدم وكلمة المرور.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/auth/sign-in')).toHaveLength(0);

    type('اسم المستخدم', 'sara.office');
    type('كلمة المرور', 'wrong-one');
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    expect(await screen.findByText('اسم المستخدم أو كلمة المرور غير صحيح.')).toBeTruthy();
    const password = screen.getByLabelText<HTMLInputElement>('كلمة المرور');
    expect(password.value).toBe('');
    expect(password.getAttribute('aria-invalid')).toBe('true');

    type('كلمة المرور', 'wrong-again');
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    expect(await screen.findByText(/قُفل الحساب 15 دقيقة/)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'دخول' });
    expect(button.hasAttribute('disabled')).toBe(true);
    type('اسم المستخدم', 'someone.else');
    expect(screen.getByRole('button', { name: 'دخول' }).hasAttribute('disabled')).toBe(false);
  });

  it('server unreachable: the message, sign-in disabled, and "Try again" reconnects', async () => {
    const bridge = new FakeBridge();
    bridge.on(
      'GET',
      '/api/v1/devices/me',
      { kind: 'unreachable' },
      ok({ device: bridge.local.device, keyExpiresAt: '2027-10-07' }),
    );
    await startApp(bridge);
    expect(screen.getByText(/تعذّر الاتصال بالخادم الرئيسي/)).toBeTruthy();
    expect(screen.getByText('الخادم الرئيسي غير متاح')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'دخول' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('تم الاتصال بالخادم الرئيسي')).toBeTruthy();
    expect(screen.getByText('متصل بالخادم الرئيسي')).toBeTruthy();
    expect(screen.queryByText(/تعذّر الاتصال/)).toBeNull();
  });

  it('works the same in English, left to right', async () => {
    await act(() => setLanguage('en'));
    const bridge = new FakeBridge().on(
      'POST',
      '/api/v1/auth/sign-in',
      failure(401, 'INVALID_CREDENTIALS'),
    );
    await startApp(bridge);
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeTruthy();
    type('Username', 'sara.office');
    type('Password', 'nope-nope-nope');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Username or password is incorrect.')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Forgot your password? Ask the system admin' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Ask the owner to reset it/)).toBeTruthy();
  });
});

describe('PIN sign-in, only on POS PCs (decision 0021)', () => {
  const posBridge = () => {
    const bridge = new FakeBridge(POS);
    bridge.on(
      'GET',
      '/api/v1/auth/pin-users',
      ok({
        pinAllowed: true,
        users: [
          { id: '11', displayNameAr: 'أحمد حسن', displayNameEn: 'Ahmed Hassan', blocked: false },
          { id: '12', displayNameAr: 'يوسف خالد', displayNameEn: 'Yousef Khalid', blocked: true },
        ],
      }),
    );
    return bridge;
  };

  it('picks a name and takes the PIN from the keypad; a wrong PIN clears the dots', async () => {
    const bridge = posBridge().on('POST', '/api/v1/auth/pin-sign-in', failure(401, 'INVALID_PIN'));
    await startApp(bridge);
    expect(screen.getByRole('heading', { name: 'الدخول السريع' })).toBeTruthy();
    expect(
      (await screen.findByRole('button', { name: /يوسف خالد/ })).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    expect(await screen.findByText('اختر اسمك أولًا.')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: /أحمد حسن/ }));
    for (const digit of ['4', '8', '2', '9'])
      fireEvent.click(screen.getByRole('button', { name: digit }));
    expect(await screen.findByText('الرمز غير صحيح. حاول مرة أخرى.')).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/auth/pin-sign-in')[0]?.body).toEqual({
      userId: '11',
      pin: '4829',
    });
    expect(screen.getByRole('status', { name: 'الرمز: أُدخل 0 من 4 أرقام' })).toBeTruthy();
  });

  it('a cashier can still switch to the password form', async () => {
    await startApp(posBridge());
    fireEvent.click(screen.getByRole('button', { name: 'كلمة المرور' }));
    expect(await screen.findByRole('heading', { name: 'أهلًا بك' })).toBeTruthy();
  });
});

describe('owner 2-step code (decision 0022)', () => {
  it('pasting the code fills the six boxes; a wrong code shows the design message', async () => {
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer({ stage: 'second_factor' })))
      .on(
        'POST',
        '/api/v1/auth/second-factor',
        failure(401, 'INVALID_TWO_STEP_CODE'),
        ok(signInAnswer({}, {}, 'token-2')),
      )
      .on('GET', '/api/v1/auth/me', me());
    await startApp(bridge);
    type('اسم المستخدم', 'owner');
    type('كلمة المرور', 'long-owner-password');
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    await screen.findByRole('heading', { name: 'تأكيد هوية المالك' });

    fireEvent.paste(screen.getByLabelText('رقم 1'), {
      clipboardData: { getData: () => '١٢٣ ٤٥٦' },
    });
    expect(
      [1, 2, 3, 4, 5, 6].map((n) => screen.getByLabelText<HTMLInputElement>(`رقم ${n}`).value),
    ).toEqual(['1', '2', '3', '4', '5', '6']);
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }));
    expect(
      await screen.findByText('الرمز غير صحيح أو انتهت صلاحيته. أدخل الرمز الجديد من التطبيق.'),
    ).toBeTruthy();
    expect(bridge.callsTo('POST', '/api/v1/auth/second-factor')[0]?.body).toEqual({
      code: '123456',
    });

    fireEvent.click(screen.getByRole('button', { name: 'فقدت هاتفك؟ استخدم رمز استرداد' }));
    type('رمز الاسترداد', 'abcde-fghjk');
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }));
    await screen.findByRole('heading', { name: 'أهلًا، سارة علي' });
    expect(bridge.callsTo('POST', '/api/v1/auth/second-factor')[1]?.body).toEqual({
      recoveryCode: 'abcde-fghjk',
    });
    expect(bridge.callsTo('GET', '/api/v1/auth/me')[0]?.token).toBe('token-2');
  });

  it('"Back" ends the half-finished sign-in on the server', async () => {
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer({ stage: 'second_factor' })))
      .on('POST', '/api/v1/auth/sign-out', ok({ ok: true }));
    await startApp(bridge);
    type('اسم المستخدم', 'owner');
    type('كلمة المرور', 'long-owner-password');
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    fireEvent.click(await screen.findByRole('button', { name: 'رجوع' }));
    await screen.findByRole('heading', { name: 'أهلًا بك' });
    expect(bridge.callsTo('POST', '/api/v1/auth/sign-out')).toHaveLength(1);
    expect(screen.getByText('تم تسجيل الخروج.')).toBeTruthy();
  });

  it('first time: QR and key, then 10 recovery codes shown once; Continue needs the tick', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `AAAA${i}-BBBBB`);
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer({ pending: 'two_step_setup' })))
      .on(
        'POST',
        '/api/v1/auth/two-step/start',
        ok({
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          uri: 'otpauth://totp/ARTEPOOL:owner?secret=JBSWY3DPEHPK3PXP',
        }),
      )
      .on(
        'POST',
        '/api/v1/auth/two-step/confirm',
        ok({ ...signInAnswer({}, {}, 'token-3'), recoveryCodes: codes }),
      )
      .on('GET', '/api/v1/auth/me', me());
    await startApp(bridge);
    type('اسم المستخدم', 'owner');
    type('كلمة المرور', 'long-owner-password');
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    await screen.findByRole('heading', { name: 'إعداد التحقق بخطوتين' });
    expect(await screen.findByRole('img', { name: 'رمز QR لتطبيق المصادقة' })).toBeTruthy();
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeTruthy();
    fireEvent.paste(screen.getByLabelText('رقم 1'), { clipboardData: { getData: () => '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد' }));

    await screen.findByRole('heading', { name: 'رموز الاسترداد الخاصة بك' });
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(10);
    const proceed = screen.getByRole('button', { name: 'متابعة' });
    expect(proceed.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'طبعت هذه الرموز أو كتبتها' }));
    expect(screen.getByRole('button', { name: 'متابعة' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'متابعة' }));
    await screen.findByRole('heading', { name: 'أهلًا، سارة علي' });
    expect(screen.queryByText(codes[0]!)).toBeNull();
  });
});

describe('first sign-in: choose your own password or PIN (decision 0023)', () => {
  it('reuses the temporary password, checks the two entries, and lists the server reasons', async () => {
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer({ pending: 'credential_change' })))
      .on(
        'POST',
        '/api/v1/auth/change-password',
        failure(422, 'PASSWORD_REJECTED', { problems: ['too_short', 'common'], minLength: 12 }),
        ok(sessionView()),
      )
      .on('GET', '/api/v1/auth/me', me());
    await startApp(bridge);
    type('اسم المستخدم', 'sara.office');
    type('كلمة المرور', 'ABCD-EFGH-JKLM');
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    await screen.findByRole('heading', { name: 'اختر كلمة مرورك الخاصة' });
    expect(screen.queryByLabelText('كلمة المرور المؤقتة')).toBeNull();

    type('كلمة المرور الجديدة', 'password1');
    type('اكتبها مرة أخرى', 'password2');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ ومتابعة' }));
    expect(await screen.findByText('الإدخالان غير متطابقين.')).toBeTruthy();

    type('كلمة المرور الجديدة', 'password1');
    type('اكتبها مرة أخرى', 'password1');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ ومتابعة' }));
    expect(await screen.findByText('قصيرة جدًا: استخدم 12 حرفًا على الأقل.')).toBeTruthy();
    expect(screen.getByText('كلمة المرور هذه شائعة جدًا.')).toBeTruthy();

    type('كلمة المرور الجديدة', 'a quiet blue pool at noon');
    type('اكتبها مرة أخرى', 'a quiet blue pool at noon');
    fireEvent.click(screen.getByRole('button', { name: 'حفظ ومتابعة' }));
    await screen.findByRole('heading', { name: 'أهلًا، سارة علي' });
    expect(bridge.callsTo('POST', '/api/v1/auth/change-password')[1]?.body).toEqual({
      currentPassword: 'ABCD-EFGH-JKLM',
      newPassword: 'a quiet blue pool at noon',
    });
  });
});

describe('lock and session end', () => {
  it('the lock screen takes the same person back; "someone else" signs out', async () => {
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer()))
      .on('GET', '/api/v1/auth/me', me())
      .on('POST', '/api/v1/auth/lock', ok(sessionView({ locked: true })))
      .on('POST', '/api/v1/auth/unlock', failure(401, 'INVALID_CREDENTIALS'), ok(sessionView()))
      .on('POST', '/api/v1/auth/sign-out', ok({}));
    await startApp(bridge);
    type('اسم المستخدم', 'sara.office');
    type('كلمة المرور', 'blue-pool-water');
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    await accountMenu('قفل الشاشة');
    await screen.findByRole('heading', { name: 'الشاشة مقفلة' });
    expect(screen.getByText('سارة علي، أدخل كلمة المرور للمتابعة.')).toBeTruthy();
    type('كلمة المرور', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'فتح القفل' }));
    expect(await screen.findByText('اسم المستخدم أو كلمة المرور غير صحيح.')).toBeTruthy();
    type('كلمة المرور', 'blue-pool-water');
    fireEvent.click(screen.getByRole('button', { name: 'فتح القفل' }));
    await screen.findByRole('heading', { name: 'أهلًا، سارة علي' });

    await accountMenu('قفل الشاشة');
    fireEvent.click(await screen.findByRole('button', { name: 'الدخول باسم شخص آخر' }));
    await screen.findByRole('heading', { name: 'أهلًا بك' });
    expect(bridge.callsTo('POST', '/api/v1/auth/sign-out')).toHaveLength(1);
  });

  it('an ended session returns to sign-in with a short explanation', async () => {
    const bridge = new FakeBridge()
      .on('POST', '/api/v1/auth/sign-in', ok(signInAnswer()))
      .on('GET', '/api/v1/auth/me', me())
      .on('POST', '/api/v1/auth/lock', failure(401, 'SESSION_EXPIRED'));
    await startApp(bridge);
    type('اسم المستخدم', 'sara.office');
    type('كلمة المرور', 'blue-pool-water');
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    await accountMenu('قفل الشاشة');
    await waitFor(() =>
      expect(screen.getByText('انتهت جلستك. سجّل الدخول مرة أخرى.')).toBeTruthy(),
    );
    expect(screen.getByRole('heading', { name: 'أهلًا بك' })).toBeTruthy();
  });
});
