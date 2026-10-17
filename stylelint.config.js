// Stylelint for the desktop app (CLAUDE.md golden rules 11 and 12): no raw colours or fonts in
// components (design tokens only), and logical properties only, so every layout works in
// Arabic (RTL) and English (LTR).
const physical = ['left', 'right'];

export default {
  rules: {
    'color-no-hex': [true, { message: 'Use a colour token (var(--color-…)), never a raw colour.' }],
    'color-named': [
      'never',
      { message: 'Use a colour token (var(--color-…)), never a named colour.' },
    ],
    'function-disallowed-list': [
      ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'],
      { message: 'Use a colour token (var(--color-…)), never a raw colour.' },
    ],
    'property-disallowed-list': [
      [
        ...physical,
        ...physical.flatMap((side) => [`margin-${side}`, `padding-${side}`, `border-${side}`]),
        ...physical.flatMap((side) => [
          `border-${side}-width`,
          `border-${side}-color`,
          `border-${side}-style`,
        ]),
        'border-top-left-radius',
        'border-top-right-radius',
        'border-bottom-left-radius',
        'border-bottom-right-radius',
      ],
      { message: 'Use logical properties (inline-start / inline-end) so RTL and LTR both work.' },
    ],
    'declaration-property-value-disallowed-list': [
      { 'text-align': ['left', 'right'], float: ['left', 'right'], clear: ['left', 'right'] },
      { message: 'Use start / end, not left / right, so RTL and LTR both work.' },
    ],
    'declaration-property-value-allowed-list': [
      { 'font-family': ['/^var\\(--font-(family|mono|heading)\\)$/', 'inherit'] },
      {
        message:
          'Use the font tokens (var(--font-family), var(--font-heading) or var(--font-mono)).',
      },
    ],
  },
  overrides: [
    {
      // The token files and the font faces are where raw values belong.
      files: [
        'apps/desktop/src/theme/tokens.css',
        'apps/desktop/src/theme/tokens-app.css',
        'apps/desktop/src/theme/fonts.css',
      ],
      rules: {
        'color-no-hex': null,
        'function-disallowed-list': null,
        'declaration-property-value-allowed-list': null,
      },
    },
  ],
};
