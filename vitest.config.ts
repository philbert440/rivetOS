import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'src/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'plugins/*/src/**/*.test.ts',
      'plugins/*/*/src/**/*.test.ts',
    ],
    testTimeout: 30000,
  },
});
