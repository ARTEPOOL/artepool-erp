import { describe, expect, it } from 'vitest';
import { checkLocales, placeholdersOf } from '../src/check-keys';
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

  it('reports required keys that no language has', () => {
    const problems = checkLocales({ ar: { common: {} }, en: { common: {} } }, { common: ['x'] });
    expect(problems).toHaveLength(2);
  });

  it('passes for the real Arabic and English texts', () => {
    expect(checkLocales(resources)).toEqual([]);
  });
});
