/**
 * The first-run wizard, path "Restore from backup" (decision 0102, M6.2 part E), against a
 * scripted native side: the copies found are listed, newest first; an encrypted copy asks for the
 * private key (typed or from the key file) and a wrong one is refused before anything starts; a
 * plain copy warns that the phone codes must be set up again; the steps show while it runs; a
 * failure says that nothing was changed; after a restore this PC is enrolled with the restore's
 * code and sign-in follows.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RestoreCopy, SetupStatusResponse } from '@artepool/shared/contracts';
import { App } from '../../src/app/App';
import { FakeBridge, ok, POS } from '../support/fake-bridge';

const KEY = `AGE-SECRET-KEY-1${'Q'.repeat(58)}`;

const STATUS: SetupStatusResponse = {
  state: 'not_started',
  path: null,
  company: null,
  owner: null,
  posDevice: null,
};

const DRIVE_COPY: RestoreCopy = {
  path: 'C:\\Users\\Owner\\Downloads\\artepool-20261023-230000Z.dump.age',
  name: 'artepool-20261023-230000Z.dump.age',
  bytes: 5 * 1024 * 1024,
  modifiedAt: '2026-10-23T23:05:00Z',
  place: 'downloads',
  encrypted: true,
};

const USB_COPY: RestoreCopy = {
  path: 'E:\\ARTEPOOL-BACKUPS\\artepool-20261020-100000Z.dump',
  name: 'artepool-20261020-100000Z.dump',
  bytes: 4 * 1024 * 1024,
  modifiedAt: '2026-10-20T10:01:00Z',
  place: 'removable',
  encrypted: false,
};

const RESTORED = {
  ok: true as const,
  masterKeyRestored: true,
  revokedDevices: 3,
  devicesWithOpenShifts: [],
  enrollment: { code: 'WXYZ-2345', expiresAt: '2026-10-24T10:10:00Z' },
  backup: { ok: true },
};

function serverPc(copies: RestoreCopy[] = [DRIVE_COPY, USB_COPY]): FakeBridge {
  const bridge = new FakeBridge(null).on('GET', '/api/v1/setup/status', ok(STATUS));
  bridge.setup = { available: true, serverAddress: '127.0.0.1:3100', windowsBuild: null };
  bridge.restoreFound = copies;
  return bridge;
}

async function openRestore() {
  await screen.findByRole('heading', { name: 'أهلًا بيك في آرتيبول' });
  fireEvent.click(screen.getByRole('button', { name: 'استرجع من نسخة احتياطية' }));
  await screen.findByRole('heading', { name: 'اختار النسخة الاحتياطية' });
}

const continueButton = () => screen.getByRole('button', { name: 'كمّل' });

describe('restore from backup', () => {
  it('an encrypted copy: the key, the steps, then this PC is enrolled with the restore code', async () => {
    const bridge = serverPc();
    bridge.restoreStatuses = [
      { running: true, step: 'checking', result: null },
      { running: false, step: 'backing_up', result: RESTORED },
    ];
    bridge.enrollOutcome = { ok: true, serverUrl: 'https://127.0.0.1:3100', device: POS };
    render(<App bridge={bridge} />);
    await openRestore();

    // Newest first, already chosen; where each one is and whether it is encrypted.
    const radios = await screen.findAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual([
      DRIVE_COPY.path,
      USB_COPY.path,
    ]);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/متشفّرة \(Google Drive\)/)).toBeTruthy();
    expect(screen.getByText(/فلاشة \/ هارد خارجي/)).toBeTruthy();
    fireEvent.click(continueButton());

    // A wrong key is refused here; nothing starts.
    await screen.findByRole('heading', { name: 'مفتاح النسخ الخاص بيك' });
    fireEvent.change(screen.getByLabelText('المفتاح الخاص'), { target: { value: 'age1public' } });
    fireEvent.click(continueButton());
    await screen.findByText(/ده مش مفتاح خاص/);
    expect(bridge.restoreStarts).toEqual([]);
    fireEvent.change(screen.getByLabelText('المفتاح الخاص'), {
      target: { value: `# created: 2026-10-01\n${KEY}\n` },
    });
    fireEvent.click(continueButton());

    await screen.findByRole('heading', { name: 'جاهز للاسترجاع' });
    expect(screen.queryByText(/مش متشفّرة، يعني/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ابدأ الاسترجاع' }));

    // The steps while it runs, then the result.
    await screen.findByRole('heading', { name: 'جاري الاسترجاع…' });
    expect(bridge.restoreStarts).toEqual([{ path: DRIVE_COPY.path, privateKey: KEY }]);
    await waitFor(() =>
      expect(screen.getByText(/مراجعة كل حاجة/).getAttribute('aria-current')).toBe('step'),
    );
    await screen.findByRole('heading', { name: 'بياناتك رجعت' }, { timeout: 3000 });
    expect(screen.getByText(/أجهزة السيرفر القديم اللي محتاجة تتسجّل تاني: 3/)).toBeTruthy();
    expect(screen.getByText(/اربط Google Drive تاني/)).toBeTruthy();

    // This PC as the point of sale, with the code the restore made; no setup step is sent.
    fireEvent.click(screen.getByRole('button', { name: 'سجّل الجهاز ده' }));
    await screen.findByRole('heading', { name: 'الجهاز ده' });
    fireEvent.click(screen.getByRole('button', { name: 'سجّل الجهاز ده وكمّل' }));
    await screen.findByRole('heading', { name: 'الإعداد خلص' });
    expect(bridge.enrollCalls).toEqual([
      expect.objectContaining({
        serverAddress: '127.0.0.1:3100',
        code: 'WXYZ-2345',
        deviceKind: 'pos',
      }),
    ]);
    expect(bridge.setupCalls.map((c) => c.path)).toEqual(['/api/v1/setup/status']);
  });

  it('a plain copy (the external drive) needs no key and warns about the phone codes', async () => {
    const bridge = serverPc([USB_COPY]);
    bridge.restoreStatuses = [
      { running: false, step: 'backing_up', result: { ...RESTORED, masterKeyRestored: false } },
    ];
    render(<App bridge={bridge} />);
    await openRestore();
    await screen.findAllByRole('radio');
    fireEvent.click(continueButton());
    await screen.findByRole('heading', { name: 'جاهز للاسترجاع' });
    expect(screen.getByText(/مش متشفّرة، يعني مفيهاش المفتاح الرئيسي/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ابدأ الاسترجاع' }));
    await screen.findByRole('heading', { name: 'بياناتك رجعت' });
    expect(bridge.restoreStarts).toEqual([{ path: USB_COPY.path, privateKey: '' }]);
    expect(screen.getByText(/مكانش فيها المفتاح الرئيسي/)).toBeTruthy();
  });

  it('nothing found: how to bring the Google Drive copy; a typed path is checked', async () => {
    const bridge = serverPc([]);
    render(<App bridge={bridge} />);
    await openRestore();
    await screen.findByText(/مفيش نسخة احتياطية اتلقت/);
    expect(screen.getByText(/drive.google.com/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('أو اكتب المسار الكامل للملف'), {
      target: { value: 'D:\\photo.jpg' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'استخدم الملف ده' }));
    await screen.findByText(/مفيش نسخة احتياطية في المسار ده/);
    expect(bridge.restoreLookups).toEqual([undefined, 'D:\\photo.jpg']);
    fireEvent.click(continueButton());
    await screen.findByText('اختار نسخة الأول.');
  });

  it('a failed restore says nothing was changed; a wrong key goes back to the key', async () => {
    const bridge = serverPc([DRIVE_COPY]);
    bridge.restoreStatuses = [
      { running: false, step: 'opening', result: { ok: false, reason: 'wrong_key' } },
    ];
    render(<App bridge={bridge} />);
    await openRestore();
    await screen.findAllByRole('radio');
    fireEvent.click(continueButton());
    fireEvent.change(await screen.findByLabelText('المفتاح الخاص'), { target: { value: KEY } });
    fireEvent.click(continueButton());
    fireEvent.click(await screen.findByRole('button', { name: 'ابدأ الاسترجاع' }));
    await screen.findByRole('heading', { name: 'محصلش أي تغيير' });
    expect(screen.getByText(/المفتاح ده مبيفتحش النسخة دي/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'جرّب تاني' }));
    await screen.findByRole('heading', { name: 'مفتاح النسخ الخاص بيك' });
  });

  it('the restore program cannot start: run the app as administrator', async () => {
    const bridge = serverPc([USB_COPY]);
    bridge.restoreRefusal = 'launch_failed';
    render(<App bridge={bridge} />);
    await openRestore();
    await screen.findAllByRole('radio');
    fireEvent.click(continueButton());
    fireEvent.click(await screen.findByRole('button', { name: 'ابدأ الاسترجاع' }));
    await screen.findByText(/Run as administrator/);
  });
});
