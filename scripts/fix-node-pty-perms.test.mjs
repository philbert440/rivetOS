// Run: node --test scripts/fix-node-pty-perms.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureExecutable, spawnHelperPaths } from './fix-node-pty-perms.mjs'

test('finds every prebuild helper and a source build, and makes them executable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-pty-'))
  try {
    const helpers = [
      join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
      join(dir, 'prebuilds', 'darwin-x64', 'spawn-helper'),
      join(dir, 'build', 'Release', 'spawn-helper'),
    ]
    for (const p of helpers) {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, '')
      chmodSync(p, 0o644)
    }
    mkdirSync(join(dir, 'prebuilds', 'win32-x64'), { recursive: true }) // no helper: skipped
    assert.deepEqual(spawnHelperPaths(dir).sort(), [...helpers].sort())

    assert.deepEqual(ensureExecutable(helpers).sort(), [...helpers].sort())
    for (const p of helpers) assert.equal(statSync(p).mode & 0o777, 0o755)
    // Idempotent: nothing left to change.
    assert.deepEqual(ensureExecutable(helpers), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a node-pty dir without helpers yields nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-pty-'))
  try {
    assert.deepEqual(spawnHelperPaths(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
