import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const captureDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(captureDir, '..')

export default defineConfig({
  root: packageRoot,
  test: {
    environment: 'node',
    include: [
      'capture/test/den-transport.test.ts',
      'capture/test/wrapper.test.ts',
      'plugin/test/**/*.test.ts',
      'capture/test/state.test.ts',
    ],
  },
})
