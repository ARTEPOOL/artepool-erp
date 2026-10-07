// ESLint rule (CLAUDE.md golden rule 11): no hard-coded UI text in the desktop app.
// Every word a person reads must come from i18n (ar + en). Reports JSX text that contains a
// letter, and literal accessibility / placeholder / title attributes.
const LETTER = /\p{L}/u;
const TEXT_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'title',
  'placeholder',
  'alt',
  'label',
]);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow hard-coded user-facing text; use i18n (t()).' },
    messages: {
      text: 'Hard-coded text "{{text}}". Put it in packages/i18n (ar + en) and use t().',
    },
    schema: [],
  },
  create(context) {
    const report = (node, text) =>
      context.report({ node, messageId: 'text', data: { text: text.trim().slice(0, 40) } });
    return {
      JSXText(node) {
        if (LETTER.test(node.value)) report(node, node.value);
      },
      JSXAttribute(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : '';
        if (!TEXT_ATTRIBUTES.has(name) || !node.value) return;
        if (
          node.value.type === 'Literal' &&
          typeof node.value.value === 'string' &&
          LETTER.test(node.value.value)
        ) {
          report(node, node.value.value);
        }
        if (
          node.value.type === 'JSXExpressionContainer' &&
          node.value.expression.type === 'Literal' &&
          typeof node.value.expression.value === 'string' &&
          LETTER.test(node.value.expression.value)
        ) {
          report(node, node.value.expression.value);
        }
      },
    };
  },
};
