import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './specs',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'artifacts/results.json' }],
  ],
  outputDir: 'test-results',
})
