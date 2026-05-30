// Root ESLint flat config. Consumes the shared @moxxy/eslint-config (imported
// by path to avoid adding a workspace devDep + lockfile churn). The shared
// config already ignores dist/node_modules/.turbo/coverage.
import base from './tooling/eslint-config/index.js';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/dist/**',
      // Electron's main/preload bundle output — built artifacts, not source.
      '**/dist-electron/**',
      // Astro's generated content types.
      '**/.astro/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.timestamp-*.mjs',
      // Other agents' isolated git worktrees — full repo copies; not ours to lint.
      '.claude/**',
      '**/.git/**',
    ],
  },
  ...base,
  // React surfaces (desktop renderer, Ink TUI) get the hooks rules. Both
  // are warnings so they guide without failing CI; the desktop already
  // carries intentional `eslint-disable-next-line react-hooks/exhaustive-deps`
  // directives, which this makes valid (the rule now exists).
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
