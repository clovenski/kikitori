import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'resources', 'data', 'output', 'dist', 'out', '.superpowers'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
              message: 'src/core must stay free of Electron and React.',
            },
            {
              group: ['**/cli/*', '**/main/*', '**/preload/*', '**/renderer/*'],
              message: 'src/core must not depend on app layers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/renderer/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', 'node:*'],
              message: 'The renderer must not use Node or Electron APIs; use window.bgt.',
            },
            {
              group: ['**/core/**', '!**/core/time', '!**/core/errors', '!**/core/youtube'],
              allowTypeImports: true,
              message: 'The renderer may only import types and the pure modules core/time, core/errors, core/youtube.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**'], allowTypeImports: true, message: 'src/app/shared may only import types.' }] },
      ],
    },
  },
);
