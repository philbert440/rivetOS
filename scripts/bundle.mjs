#!/usr/bin/env node

/**
 * bundle.mjs — Produce a single-file ESM bundle of the @rivetos/cli runtime.
 *
 * Replaces the per-package `tsc` chain inside container images. The npm publish
 * pipeline still uses per-package `tsc` builds; this bundle is purely for the
 * container build path.
 *
 * Output: dist/rivetos.js (single file, ~2 MB), preserves Node native module
 * deps as externals (bundled image still has node_modules with these).
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, statSync } from 'fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist');
mkdirSync(outdir, { recursive: true });

const start = Date.now();

await build({
  entryPoints: [resolve(root, 'packages/cli/src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: resolve(outdir, 'rivetos.js'),
  sourcemap: true,
  // Preserve `import.meta.url` semantics; esbuild handles ESM dynamic resolution.
  external: [
    // Native bindings — must remain as runtime deps in the container image.
    'pg-native',
    'better-sqlite3',
    '@discordjs/voice',
    '@elevenlabs/elevenlabs-js',
    // pg uses optional pg-native; keep it as runtime resolution.
    'pg',
    // MCP SDK has its own runtime resolution path.
    '@modelcontextprotocol/sdk',
  ],
  // Avoid esbuild's TypeScript decorator emit drift.
  tsconfig: resolve(root, 'tsconfig.base.json'),
  logLevel: 'info',
});

const stats = statSync(resolve(outdir, 'rivetos.js'));
const mb = (stats.size / 1024 / 1024).toFixed(2);
const ms = Date.now() - start;
console.log(`✓ Bundled dist/rivetos.js — ${mb} MB in ${ms} ms`);
