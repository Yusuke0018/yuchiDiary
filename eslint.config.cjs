const js = require('@eslint/js');
const pluginImport = require('eslint-plugin-import');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'functions/node_modules/**',
      '.firebase/**',
      '.codex/logs/**',
      'dist/**',
    ],
  },
  {
    ...js.configs.recommended,
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      import: pluginImport,
    },
    rules: {
      'no-console': ['warn', { allow: ['error', 'warn', 'info'] }],
      'import/no-unresolved': 'off',
      'import/extensions': 'off',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        Chart: 'readonly',
        luxon: 'readonly',
      },
    },
  },
  {
    files: ['functions/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
