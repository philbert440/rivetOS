/**
 * @rivetos/types — export verification tests.
 *
 * Types-only package. These tests verify all expected exports exist
 * and are accessible at the module boundary.
 */

import { describe, it } from 'vitest'
import * as assert from 'node:assert/strict'

describe('@rivetos/types exports', () => {
  it('should re-export all type modules without error', async () => {
    // Dynamic import to test the actual module resolution
    const types = await import('./index.js')

    // The module should load without throwing.
    // Since this is a type-only package (all `export type`), the runtime
    // module object will be empty — but the import itself must succeed.
    assert.ok(types !== null, 'Module loaded')
    assert.equal(typeof types, 'object', 'Module is an object')
  })

  it('should export from message.ts', async () => {
    const mod = await import('./message.js')
    assert.ok(mod !== null)
  })

  it('should export from provider.ts', async () => {
    const mod = await import('./provider.js')
    assert.ok(mod !== null)
  })

  it('should export from channel.ts', async () => {
    const mod = await import('./channel.js')
    assert.ok(mod !== null)
  })

  it('should export from tool.ts', async () => {
    const mod = await import('./tool.js')
    assert.ok(mod !== null)
  })

  it('should export from memory.ts', async () => {
    const mod = await import('./memory.js')
    assert.ok(mod !== null)
  })

  it('should export from workspace.ts', async () => {
    const mod = await import('./workspace.js')
    assert.ok(mod !== null)
  })

  it('should export from config.ts', async () => {
    const mod = await import('./config.js')
    assert.ok(mod !== null)
  })

  it('should export from users-registry.ts', async () => {
    const mod = await import('./users-registry.js')
    assert.ok(mod !== null)
    assert.equal(typeof mod.resolveUser, 'function')
    assert.equal(typeof mod.parseUsersRegistry, 'function')
    assert.equal(typeof mod.loadUsersRegistry, 'function')
    assert.equal(typeof mod.userDbsFromRegistry, 'function')
    assert.equal(mod.DEFAULT_OWNER_USER_ID, 'phil')
  })

  it('should export from events.ts', async () => {
    const mod = await import('./events.js')
    assert.ok(mod !== null)
  })

  it('should export sharedDir/sharedPath from the barrel', async () => {
    const types = await import('./index.js')
    assert.equal(typeof types.sharedDir, 'function')
    assert.equal(typeof types.sharedPath, 'function')
  })

  it('should export installRoot/installPath from the barrel', async () => {
    const types = await import('./index.js')
    assert.equal(typeof types.installRoot, 'function')
    assert.equal(typeof types.installPath, 'function')
  })
})
