// ESLint for the whole repo: the services, packages, jobs and scripts (Node) and the web app (React in
// the browser, plus its workers). It runs without type information, so it is quick and needs only the
// root's packages; TypeScript checks the types (npm run typecheck) and Prettier the layout
// (npm run format:check). A rule broken on purpose gets an eslint-disable comment saying why.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', 'web/public/', 'deploy/cloudflare/down-page/font.ts']),
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // a leading underscore marks a parameter or binding as unused on purpose
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // a `let` the health checks read before start-up assigns it stays a `let`
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    extends: [jsxA11y.flatConfigs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      // The hooks rules every React app needs. The plugin's other rules check fitness for the React
      // Compiler, which cubr doesn't use: they flag the latest-value ref and the timer reading the clock
      // while it renders, both meant here.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // autoFocus is only on a dialog's field (the dialog pattern; Modal.tsx relies on it), a field the
      // user just opened, or a one-field page (the new account's username)
      'jsx-a11y/no-autofocus': 'off',
    },
  },
  {
    // chart.js's options and scriptable contexts are typed per chart kind; these pass them through
    files: ['web/src/components/ChartCanvas.tsx', 'web/src/components/social/Charts.tsx', 'web/src/components/social/HistoryChart.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  { files: ['web/src/sw/**'], languageOptions: { globals: globals.serviceworker } },
  { files: ['web/src/**/*.worker.ts'], languageOptions: { globals: globals.worker } },
  { files: ['web/src/**/*.worklet.js'], languageOptions: { globals: globals.audioWorklet } },
  { files: ['deploy/cloudflare/**'], languageOptions: { globals: globals.serviceworker } },
);
