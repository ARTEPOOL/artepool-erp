/**
 * "ARTÉPOOL – Emergency tool" (decision 0107) against a scripted native side: on any other PC it
 * says so and offers nothing; a reset needs a written reason before anything runs; the temporary
 * password is shown once and forgotten on "Done"; the enrollment code shows its time; the system
 * check marks each line green or red; a failure says why.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  EmergencyAnswer,
  EmergencyCheck,
  EmergencyInfo,
  EmergencyRun,
} from '@artepool/shared/contracts';
import type { EmergencyBridge } from '../../src/features/emergency/bridge';
import { EmergencyTool } from '../../src/features/emergency/EmergencyTool';

class FakeEmergency implements EmergencyBridge {
  runs: EmergencyRun[] = [];
  logsOpened = 0;
  constructor(
    public found: EmergencyInfo = { emergency: true, serverPc: true },
    public answers: Partial<Record<EmergencyRun['action'], EmergencyAnswer<unknown>>> = {},
    public checked: EmergencyAnswer<EmergencyCheck> = { ok: false, reason: 'launch_failed' },
  ) {}
  info() {
    return Promise.resolve(this.found);
  }
  check() {
    return Promise.resolve(this.checked);
  }
  run<T>(request: EmergencyRun) {
    this.runs.push(request);
    return Promise.resolve(
      (this.answers[request.action] ?? { ok: false, reason: 'failed' }) as EmergencyAnswer<T>,
    );
  }
  openLogs() {
    this.logsOpened += 1;
    return Promise.resolve(true);
  }
}

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('emergency tool (decision 0107)', () => {
  it('on another PC says so and offers no action', async () => {
    render(<EmergencyTool bridge={new FakeEmergency({ emergency: true, serverPc: false })} />);
    expect(await screen.findByRole('heading', { name: 'الجهاز ده مش جهاز السيرفر' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'اعمل كلمة سر جديدة' })).toBeNull();
  });

  it('resets the password only with a reason, shows it once and forgets it on Done', async () => {
    const bridge = new FakeEmergency(undefined, {
      'reset-password': {
        ok: true,
        result: { username: 'mohammed', temporaryPassword: 'Tmp-7Kq2-Pw9x', twoStepCleared: true },
      },
    });
    render(<EmergencyTool bridge={bridge} />);
    await screen.findByRole('heading', { name: 'آرتيبول – أداة الطوارئ' });
    press('اعمل كلمة سر جديدة');
    await screen.findByRole('heading', { name: 'كلمة سر جديدة لصاحب المحل' });

    press('اعمل كلمة سر جديدة');
    expect(await screen.findByText('اكتب السبب (3 حروف على الأقل).')).toBeTruthy();
    expect(bridge.runs).toEqual([]);

    fireEvent.change(screen.getByLabelText(/ليه محتاج تعمل كده؟/), {
      target: { value: '  forgot it  ' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    press('اعمل كلمة سر جديدة');
    expect(await screen.findByText('Tmp-7Kq2-Pw9x')).toBeTruthy();
    expect(bridge.runs).toEqual([
      { action: 'reset-password', input: { reason: 'forgot it', phoneLost: true } },
    ]);
    expect(screen.getByText(/البرنامج هيطلب تظبيط الموبايل من الأول/)).toBeTruthy();

    press('تمام');
    await screen.findByRole('heading', { name: 'آرتيبول – أداة الطوارئ' });
    expect(screen.queryByText('Tmp-7Kq2-Pw9x')).toBeNull();
    press('اعمل كلمة سر جديدة');
    await screen.findByRole('heading', { name: 'كلمة سر جديدة لصاحب المحل' });
    expect(screen.queryByText('Tmp-7Kq2-Pw9x')).toBeNull();
  });

  it('says why a reset did not happen', async () => {
    const bridge = new FakeEmergency(undefined, { 'reset-2fa': { ok: false, reason: 'no_owner' } });
    render(<EmergencyTool bridge={bridge} />);
    await screen.findByRole('button', { name: 'امسح كود الموبايل' });
    press('امسح كود الموبايل');
    fireEvent.change(await screen.findByLabelText(/ليه محتاج تعمل كده؟/), {
      target: { value: 'phone and codes lost' },
    });
    press('امسح كود الموبايل');
    expect(await screen.findByText('لسه مفيش صاحب محل. كمّل الإعداد الأول الأول.')).toBeTruthy();
    expect(bridge.runs).toEqual([
      { action: 'reset-2fa', input: { reason: 'phone and codes lost' } },
    ]);
  });

  it('makes an enrollment code with its time in Al Ain', async () => {
    const bridge = new FakeEmergency(undefined, {
      'device-code': { ok: true, result: { code: 'WXYZ-2345', expiresAt: '2026-10-25T06:10:00Z' } },
    });
    render(<EmergencyTool bridge={bridge} />);
    await screen.findByRole('button', { name: 'اعمل كود' });
    press('اعمل كود');
    await screen.findByRole('heading', { name: 'كود تسجيل جهاز' });
    press('اعمل كود');
    expect(await screen.findByText('WXYZ-2345')).toBeTruthy();
    expect(screen.getByText('يتستخدم مرة واحدة، لحد 10:10 (بتوقيت العين).')).toBeTruthy();
  });

  it('checks the system line by line and opens the logs folder', async () => {
    const bridge = new FakeEmergency(
      undefined,
      {},
      {
        ok: true,
        result: {
          services: { database: 'running', server: 'running', backup: 'stopped' },
          secrets: true,
          database: {
            ok: true,
            result: { setupComplete: true, owner: { username: 'mohammed', twoStep: true } },
          },
        },
      },
    );
    render(<EmergencyTool bridge={bridge} />);
    await screen.findByRole('button', { name: 'افتح الفولدر' });
    press('افتح الفولدر');
    await waitFor(() => expect(bridge.logsOpened).toBe(1));

    press('افحص دلوقتي');
    expect(await screen.findByText('واقفة')).toBeTruthy();
    expect(screen.getAllByText('شغالة')).toHaveLength(2);
    expect(screen.getByText('بتتفتح')).toBeTruthy();
    expect(screen.getByText('mohammed · كود الموبايل شغال')).toBeTruthy();
    expect(screen.getByText(/في حاجة مش شغالة/)).toBeTruthy();
  });
});
