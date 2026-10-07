// ESLint flat config for the whole workspace.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import noLiteralUiText from './tools/lint/no-literal-ui-text.js';

const noFloats = 'Money and quantities must never use floating point. Use @artepool/shared/money.';

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.generated.ts'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globals.node,
    },
    rules: {
      'no-restricted-globals': ['error', { name: 'parseFloat', message: noFloats }],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: noFloats },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The desktop app runs in a browser engine; every visible word comes from i18n.
    files: ['apps/desktop/src/**/*.{ts,tsx}', 'apps/desktop/test/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/desktop/src/**/*.tsx'],
    plugins: { artepool: { rules: { 'no-literal-ui-text': noLiteralUiText } } },
    rules: { 'artepool/no-literal-ui-text': 'error' },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
