import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Why a password was refused (decision 0023). The app translates each one. */
export type PasswordProblem =
  'too_short' | 'too_long' | 'common' | 'contains_username' | 'one_character';

export const PASSWORD_MAX_LENGTH = 128;

let common: ReadonlySet<string> | undefined;

/** Common passwords of 10+ characters (bundled list; shorter ones fail the length rule anyway). */
function commonPasswords(): ReadonlySet<string> {
  common ??= new Set(
    readFileSync(join(import.meta.dirname, 'common-passwords.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  );
  return common;
}

/**
 * Checks a new password: at least `minLength` characters (never below 10), at most 128, not a
 * common password, not containing the username, not one repeated character. No forced symbols
 * and no expiry (decision 0023). Returns an empty list when the password is acceptable.
 */
export function checkPassword(
  password: string,
  options: { minLength: number; username?: string },
): PasswordProblem[] {
  const text = password.normalize('NFC');
  const characters = [...text];
  const lower = text.toLowerCase();
  const problems: PasswordProblem[] = [];
  if (characters.length < Math.max(options.minLength, 10)) problems.push('too_short');
  if (characters.length > PASSWORD_MAX_LENGTH) problems.push('too_long');
  if (commonPasswords().has(lower)) problems.push('common');
  const username = options.username?.toLowerCase();
  if (username && username.length >= 3 && lower.includes(username)) {
    problems.push('contains_username');
  }
  if (characters.length > 0 && characters.every((c) => c === characters[0])) {
    problems.push('one_character');
  }
  return problems;
}
