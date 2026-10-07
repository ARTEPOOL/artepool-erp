import { describe, expect, it } from 'vitest';
import { checkPassword } from '../../src/platform/auth/password-policy';
import {
  checkPin,
  isWeakPin,
  newTemporaryPin,
  normalizePin,
} from '../../src/platform/auth/pin-policy';
import { newTotpSecret, totpCode, totpUri, verifyTotp } from '../../src/platform/auth/totp';

describe('password rules (decision 0023)', () => {
  const check = (password: string, username = 'khaled.acc', minLength = 10) =>
    checkPassword(password, { minLength, username });

  it('accepts long passwords without forcing symbols or digits', () => {
    expect(check('pool water is blue')).toEqual([]);
    expect(check('حديقة المسبح الزرقاء')).toEqual([]);
  });

  it('refuses short, overlong, common, one-character and username passwords', () => {
    expect(check('short')).toContain('too_short');
    expect(check('a'.repeat(129))).toContain('too_long');
    expect(check('1234567890')).toContain('common');
    expect(check('QWERTYUIOP')).toContain('common');
    expect(check('zzzzzzzzzzzz')).toContain('one_character');
    expect(check('my-KHALED.ACC-pass')).toContain('contains_username');
  });

  it('counts characters, not bytes, and never goes below 10', () => {
    expect(check('مسبح-العين')).toEqual([]); // 10 Arabic characters
    expect(check('nine char', 'x', 6)).toContain('too_short');
    expect(check('ten chars!', 'x', 12)).toContain('too_short');
  });
});

describe('PIN rules (decision 0021)', () => {
  it('needs exactly four digits, typed in Western or Arabic digits', () => {
    expect(checkPin('483')).toEqual(['not_four_digits']);
    expect(checkPin('48a9')).toEqual(['not_four_digits']);
    expect(checkPin('48291')).toEqual(['not_four_digits']);
    expect(normalizePin('٤٨ ٢٩')).toBe('4829');
    expect(checkPin(normalizePin('٤٨٢٩'))).toEqual([]);
  });

  it('refuses repeated digits, straight runs, pairs and very common PINs', () => {
    for (const pin of [
      '0000',
      '7777',
      '1234',
      '6789',
      '7890',
      '9876',
      '3210',
      '0987',
      '1212',
      '4545',
      '1122',
      '9900',
      '2580',
      '0852',
      '1004',
      '2000',
      '6969',
    ]) {
      expect(checkPin(pin), pin).toEqual(['weak']);
    }
    for (const pin of ['4829', '1357', '2468', '5291', '0473']) {
      expect(checkPin(pin), pin).toEqual([]);
    }
  });

  it('leaves almost all PINs available, and temporary PINs are never weak', () => {
    let weak = 0;
    for (let n = 0; n < 10_000; n++) if (isWeakPin(String(n).padStart(4, '0'))) weak++;
    expect(weak).toBeGreaterThan(150);
    expect(weak).toBeLessThan(300);
    for (let i = 0; i < 200; i++) expect(checkPin(newTemporaryPin())).toEqual([]);
  });
});

describe('2-step codes (TOTP, decision 0022)', () => {
  const secret = newTotpSecret();
  const t = Date.UTC(2026, 9, 7, 9, 0, 15); // 07/10/2026 13:00:15 in Al Ain
  const step = BigInt(Math.floor(t / 30_000));

  it('makes a 160-bit secret and a QR link for authenticator apps', () => {
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = totpUri(secret, 'mohammed');
    expect(uri).toMatch(/^otpauth:\/\/totp\/ARTEPOOL:mohammed\?/);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('accepts the current code and one step of clock difference, not more', () => {
    expect(verifyTotp(secret, totpCode(secret, t), null, t)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, t - 30_000), null, t)).toBe(step - 1n);
    expect(verifyTotp(secret, totpCode(secret, t + 30_000), null, t)).toBe(step + 1n);
    expect(verifyTotp(secret, totpCode(secret, t - 90_000), null, t)).toBeNull();
    expect(verifyTotp(secret, '12345', null, t)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', null, t)).toBeNull();
  });

  it('never accepts the same code twice, nor an older one after a newer one', () => {
    const code = totpCode(secret, t);
    const used = verifyTotp(secret, code, null, t);
    expect(verifyTotp(secret, code, used, t)).toBeNull();
    expect(verifyTotp(secret, code, used, t + 20_000)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, t - 30_000), used, t)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, t + 30_000), used, t + 30_000)).toBe(step + 1n);
  });

  it('reads codes typed in Arabic digits or with spaces', () => {
    const code = totpCode(secret, t);
    const arabic = [...code].map((d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]).join('');
    expect(verifyTotp(secret, `${arabic.slice(0, 3)} ${arabic.slice(3)}`, null, t)).toBe(step);
  });
});
