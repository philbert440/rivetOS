import { defineConfig } from 'vitest/config'

// Standalone package (not a workspace member): pin the test root here so
// vitest never walks up to the monorepo config, whose include globs are
// written against the repo root.
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
})
