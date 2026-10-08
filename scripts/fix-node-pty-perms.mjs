#!/usr/bin/env node
// node-pty ships its macOS `spawn-helper` prebuilds without the execute bit
// in some installs (npm extracts the tarball mode as-is). Every terminal open
// then fails with "posix_spawnp failed". Restore +x after install. Never
// fails the install: a missing node-pty or an unwritable file just logs.
//
// Run: node scripts/fix-node-pty-perms.mjs   (wired into root postinstall)

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** spawn-helper paths under a node-pty package dir: every prebuild, plus a source build. */
export function spawnHelperPaths(ptyDir) {
  const out = []
  const prebuilds = join(ptyDir, 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const platform of readdirSync(prebuilds)) {
      const p = join(prebuilds, platform, 'spawn-helper')
      if (existsSync(p)) out.push(p)
    }
  }
  const built = join(ptyDir, 'build', 'Release', 'spawn-helper')
  if (existsSync(built)) out.push(built)
  return out
}

/** Add +x (user, group, other) where missing. Returns the paths changed. */
export function ensureExecutable(paths) {
  const changed = []
  for (const p of paths) {
    const mode = statSync(p).mode
    if ((mode & 0o111) === 0o111) continue
    chmodSync(p, mode | 0o111)
    changed.push(p)
  }
  return changed
}

function locateNodePty() {
  // Resolve from den-server, the workspace that depends on it, so hoisting
  // (root node_modules) and nesting both work.
  const req = createRequire(join(repoRoot, 'services', 'den-server', 'package.json'))
  try {
    return dirname(req.resolve('node-pty/package.json'))
  } catch {
    return undefined
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.platform === 'win32') process.exit(0)
  try {
    const dir = locateNodePty()
    if (!dir) process.exit(0)
    const changed = ensureExecutable(spawnHelperPaths(dir))
    for (const p of changed) console.log(`fix-node-pty-perms: made executable ${p}`)
  } catch (err) {
    console.warn(
      `fix-node-pty-perms: skipped (${err instanceof Error ? err.message : String(err)})`,
    )
  }
}
