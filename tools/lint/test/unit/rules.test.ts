/** The UI lint rules (golden rules 11 and 12) catch what they must, and nothing else. */
import { join } from 'node:path';
import { Linter } from 'eslint';
import stylelint from 'stylelint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import stylelintConfig from '../../../../stylelint.config.js';
import noLiteralUiText from '../../no-literal-ui-text.js';

const linter = new Linter({ configType: 'flat' });
const lintTsx = (code: string) =>
  linter
    .verify(
      code,
      [
        {
          files: ['**/*.tsx'],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
          plugins: { artepool: { rules: { 'no-literal-ui-text': noLiteralUiText } } },
          rules: { 'artepool/no-literal-ui-text': 'error' },
        },
      ],
      'screen.tsx',
    )
    .map((m) => m.message);

describe('no hard-coded UI text', () => {
  it('reports words in JSX and in labels, placeholders and titles', () => {
    expect(lintTsx('export const A = () => <p>Sign in</p>;')).toHaveLength(1);
    expect(lintTsx('export const A = () => <p>تسجيل الدخول</p>;')).toHaveLength(1);
    expect(lintTsx('export const A = () => <input placeholder="Search" />;')).toHaveLength(1);
    expect(lintTsx("export const A = () => <button aria-label={'Close'} />;")).toHaveLength(1);
  });

  it('accepts translated text, numbers and punctuation', () => {
    expect(
      lintTsx(
        "export const A = ({ t }: { t: (k: string) => string }) => <p>{t('auth:signIn')}</p>;",
      ),
    ).toEqual([]);
    expect(lintTsx('export const A = () => <p> · 12:30 — </p>;')).toEqual([]);
    expect(lintTsx('export const A = () => <div className="rise" data-id="x" />;')).toEqual([]);
  });
});

describe('design tokens and logical CSS only', () => {
  const lintCss = async (code: string, file = 'apps/desktop/src/ui/X.module.css') => {
    const result = await stylelint.lint({
      code,
      codeFilename: join(process.cwd(), file),
      config: stylelintConfig,
    });
    return result.results[0]!.warnings.map((w) => w.rule);
  };

  it('refuses raw colours, fonts and left/right properties', async () => {
    expect(await lintCss('.a { color: #fff; }')).toEqual(['color-no-hex']);
    expect(await lintCss('.a { color: red; }')).toEqual(['color-named']);
    expect(await lintCss('.a { background: rgb(0 0 0 / 50%); }')).toEqual([
      'function-disallowed-list',
    ]);
    expect(await lintCss('.a { margin-left: 4px; }')).toEqual(['property-disallowed-list']);
    expect(await lintCss('.a { left: 0; }')).toEqual(['property-disallowed-list']);
    expect(await lintCss('.a { text-align: right; }')).toEqual([
      'declaration-property-value-disallowed-list',
    ]);
    expect(await lintCss('.a { font-family: Arial; }')).toEqual([
      'declaration-property-value-allowed-list',
    ]);
  });

  it('accepts tokens and logical properties, and raw colours only in the token files', async () => {
    expect(
      await lintCss(
        '.a { color: var(--color-text); margin-inline-start: var(--space-2); text-align: start; font-family: var(--font-family); }',
      ),
    ).toEqual([]);
    expect(await lintCss(':root { --x: #fff; }', 'apps/desktop/src/theme/tokens-app.css')).toEqual(
      [],
    );
  });
});
