import { defineConfig } from 'vitest/config'

// `nx run-many -t test --all` runs this package's `vitest run` from THIS
// directory; the root config's include globs don't apply here.
export default defineConfig({
  test: {
    include: ['schema/**/*.test.ts'],
    environment: 'node',
  },
})
