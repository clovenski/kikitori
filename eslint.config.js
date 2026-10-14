import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'resources', 'data', 'output', 'dist', '.superpowers'] },
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
);
