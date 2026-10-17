import { describe, expect, it } from 'vitest';
import { checkLocales, placeholdersOf, pluralFormsOf } from '../src/check-keys';
import { resources } from '../src/index';

describe('translation checks', () => {
  it('finds placeholders', () => {
    expect(placeholdersOf('Pay {amount} to {name} ({amount})')).toEqual(['amount', 'name']);
    expect(placeholdersOf('{count, plural, one {# item} other {# items}}')).toEqual(['count']);
  });

  it('reports missing keys, empty texts and placeholder differences', () => {
    const problems = checkLocales({
      ar: { common: { a: 'نص', b: '', c: 'المبلغ {value}' } },
      en: { common: { a: 'text', c: 'Amount {amount}', d: 'only English' } },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        { language: 'en', namespace: 'common', key: 'b', issue: 'missing' },
        { language: 'ar', namespace: 'common', key: 'b', issue: 'empty' },
        { language: 'ar', namespace: 'common', key: 'd', issue: 'missing' },
        expect.objectContaining({ key: 'c', issue: 'placeholders' }),
      ]),
    );
  });

  it('reports double braces, which would show on screen as written', () => {
    const problems = checkLocales({
      ar: { common: { a: 'على الجهاز {{code}}' } },
      en: { common: { a: 'On PC {code}' } },
    });
    expect(problems).toContainEqual({
      language: 'ar',
      namespace: 'common',
      key: 'a',
      issue: 'double_braces',
    });
  });

  it('reports required keys that no language has', () => {
    const problems = checkLocales({ ar: { common: {} }, en: { common: {} } }, { common: ['x'] });
    expect(problems).toHaveLength(2);
  });

  it('asks every language for the plural forms its grammar needs', () => {
    expect(pluralFormsOf('en')).toEqual(['one', 'other']);
    expect(pluralFormsOf('ar')).toEqual(['zero', 'one', 'two', 'few', 'many', 'other']);
    const problems = checkLocales({
      ar: { common: { rows_one: 'صف واحد', rows_other: '{count} صف' } },
      en: { common: { rows_one: '{count} row', rows_other: '{count} rows', rows_few: 'x' } },
    });
    expect(problems).toEqual(
      expect.arrayContaining([
        { language: 'ar', namespace: 'common', key: 'rows_few', issue: 'missing' },
        { language: 'ar', namespace: 'common', key: 'rows_many', issue: 'missing' },
        { language: 'ar', namespace: 'common', key: 'rows_two', issue: 'missing' },
        { language: 'ar', namespace: 'common', key: 'rows_zero', issue: 'missing' },
        expect.objectContaining({ language: 'en', key: 'rows_few', issue: 'plural_form' }),
      ]),
    );
    expect(problems).toHaveLength(5);
  });

  it('passes for the real Arabic and English texts', () => {
    expect(checkLocales(resources)).toEqual([]);
  });
});
