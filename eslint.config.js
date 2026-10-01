import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import * as espree from 'espree'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const typedFiles = [
  '{apps,packages}/*/{src,test,scripts,eval}/**/*.{ts,tsx}',
  'apps/desktop/electron.vite.config.ts',
  'vm/{guest-agent,host}/{src,test}/**/*.ts',
]

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '.claude/**', '.local/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'simple-import-sort': simpleImportSort },
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
    },
  },
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    // Shared code also runs in the daemon and the VM scripts: no browser globals.
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage', 'sessionStorage'],
    },
  },
  {
    // The VM scripts load these files with Node's type stripping (no node_modules) and the guest agent bundles
    // them on their own: they may import only each other.
    files: ['packages/shared/src/portable/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '^(?!\\./)', message: 'portable/ files import only other portable/ files.' }] },
      ],
    },
  },
  {
    // Daemon scripts run as text in the VM (`node -e`) and are turned into modules by `pnpm gen:scripts`.
    files: ['apps/daemon/src/**/scripts/*.js'],
    languageOptions: {
      parser: espree,
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Evaluated in any page a bot opens (CDP `Runtime.evaluate`): ES5 syntax, browser globals.
    files: ['apps/daemon/src/runtime/browser/scripts/*.js'],
    languageOptions: {
      parser: espree,
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...Object.fromEntries(
          ['Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Symbol'].map((n) => [n, 'readonly']),
        ),
      },
    },
    // ES5 has no optional catch binding.
    rules: { '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }] },
  },
  {
    // Evaluated in the design renderer's own Chrome: one function the daemon calls.
    files: ['apps/daemon/src/runtime/design/scripts/*.js'],
    languageOptions: {
      parser: espree,
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['apps/desktop/src/renderer/src/{ui,hooks,lib}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/app/*', '@/api/*', '@/features/*'],
              message: 'ui/, hooks/ and lib/ stay generic: take data and callbacks as arguments.',
            },
          ],
        },
      ],
    },
  },
)
