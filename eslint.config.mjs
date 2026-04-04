import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-plugin-prettier/recommended'

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      '**/*.d.ts',
      '**/*.test.ts',
      '**/*.spec.ts',
      'vitest.config.ts',
    ],
  },

  // Base JS rules
  eslint.configs.recommended,

  // TypeScript strict with type checking
  ...tseslint.configs.strictTypeChecked,

  // TypeScript settings
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Rule overrides — strict but practical
  {
    rules: {
      // Relax rules that are more noise than signal
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Allow explicit any in specific cases (will tighten over time)
      '@typescript-eslint/no-explicit-any': 'warn',

      // Allow non-null assertions — we use them intentionally
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Restrict enums is too aggressive for our use case
      '@typescript-eslint/no-unnecessary-condition': 'warn',

      // Template literal types — warn, don't error
      '@typescript-eslint/restrict-template-expressions': [
        'warn',
        {
          allowNumber: true,
          allowBoolean: true,
          allowNullish: true,
        },
      ],

      // Allow void in some cases
      '@typescript-eslint/no-confusing-void-expression': 'off',

      // Console is fine for a CLI/server project
      'no-console': 'off',
    },
  },

  // Prettier — must be last
  prettier,
)
