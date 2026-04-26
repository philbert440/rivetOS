#!/usr/bin/env node
/**
 * bundle-templates.mjs — Copy workspace-templates/ from the repo root
 * into packages/cli/workspace-templates/ so they ship inside the
 * @rivetos/cli npm tarball.
 *
 * Run as part of `npm run prepublishOnly` for @rivetos/cli.
 *
 * Idempotent: clears the destination first.
 */

import { cp, mkdir, rm, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// scripts/ → packages/cli/ → packages/ → repo root
const PKG_DIR = resolve(__dirname, '..')
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

const SRC = resolve(REPO_ROOT, 'workspace-templates')
const DEST = resolve(PKG_DIR, 'workspace-templates')

try {
  await access(SRC)
} catch {
  console.error(`✗ Source templates dir not found: ${SRC}`)
  process.exit(1)
}

await rm(DEST, { recursive: true, force: true })
await mkdir(DEST, { recursive: true })
await cp(SRC, DEST, { recursive: true })

console.log(`✓ Bundled workspace-templates → ${DEST}`)
