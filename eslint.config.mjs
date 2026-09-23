import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/generated/**',
      '.local/**',
      '.loopx/**',
      '.codex/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@opsreplay/engine',
                '@opsreplay/engine/*',
                '@opsreplay/contracts/scenario',
                '@opsreplay/contracts/server',
                '**/content/**',
                '**/apps/api/**',
                '**/schemas/scenario*',
              ],
              message:
                'The browser may import public contracts only. Keep scenario truth on the server.',
            },
          ],
        },
      ],
    },
  },
);
