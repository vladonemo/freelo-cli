import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import n from 'eslint-plugin-n';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.changeset/**',
      '**/*.d.ts',
      // Plain-JS config files — linted below with the non-typed config.
      '*.config.js',
      'scripts/**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts', 'test/**/*.ts', '*.config.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { unicorn, n },
    rules: {
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/no-null': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      'n/no-process-exit': 'off',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Agent-first: human-UX dependencies must be lazy-loaded via
    // `await import('…')` behind an `isInteractive` check so the
    // agent cold path never pays for them.
    // See `.claude/docs/conventions.md` §Imports.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            '@inquirer/prompts',
            'ora',
            'boxen',
            'cli-table3',
            'chalk',
            'pino-pretty',
            'update-notifier',
          ].map((name) => ({
            name,
            message:
              'Human-UX dependency. Use `await import(\'' +
              name +
              '\')` behind an isInteractive check. See .claude/docs/conventions.md §Imports.',
          })),
        },
      ],
    },
  },
  {
    // stdout/stderr are sacred for envelopes and structured errors.
    // All output routes through `src/ui/` (renderers) and `src/bin/`
    // (top-level error handler). Commands, API, lib, config, errors
    // must not `console.*`.
    // See `.claude/docs/conventions.md` §Output / UX.
    files: ['src/**/*.ts'],
    ignores: ['src/ui/**/*.ts', 'src/bin/**/*.ts'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
);
