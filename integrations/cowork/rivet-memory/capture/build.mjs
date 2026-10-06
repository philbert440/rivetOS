#!/usr/bin/env node
/**
 * Single-file ESM bundle of the Cowork capture sidecar.
 * A Desktop install runs this with node only — no node_modules at runtime.
 */
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(resolve(here, 'dist'), { recursive: true })

await build({
  entryPoints: [resolve(here, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  outfile: resolve(here, 'dist/cli.js'),
  logLevel: 'warning',
})
