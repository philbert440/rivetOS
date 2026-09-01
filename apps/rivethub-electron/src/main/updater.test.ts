/**
 * Tests for updater.ts — Linux AppImage install path resolution.
 */

import { describe, it, expect } from 'vitest'
import { resolveInstallPath } from './updater.js'

describe('resolveInstallPath', () => {
  const homeDir = '/home/user'
  const tmpDir = '/tmp'
  const fallback = '/home/user/.local/bin/rivethub'

  it('uses fallback when APPIMAGE is unset', () => {
    expect(resolveInstallPath(undefined, homeDir, tmpDir)).toBe(fallback)
  })

  it('uses APPIMAGE when it is a persistent path', () => {
    const persistent = '/home/user/.local/bin/rivethub-0.5.4'
    expect(resolveInstallPath(persistent, homeDir, tmpDir)).toBe(persistent)
  })

  it('uses fallback when APPIMAGE is under tmpdir', () => {
    const tempPath = '/tmp/rivethub-update-abc123/RivetHub-0.5.5.AppImage'
    expect(resolveInstallPath(tempPath, homeDir, tmpDir)).toBe(fallback)
  })

  it('uses fallback when APPIMAGE contains rivethub-update-', () => {
    const tempPath = '/var/tmp/rivethub-update-xyz/RivetHub-0.5.5.AppImage'
    expect(resolveInstallPath(tempPath, homeDir, tmpDir)).toBe(fallback)
  })

  it('uses APPIMAGE from /opt even if it contains "rivethub"', () => {
    const optPath = '/opt/rivethub/RivetHub-0.5.4.AppImage'
    expect(resolveInstallPath(optPath, homeDir, tmpDir)).toBe(optPath)
  })

  it('uses APPIMAGE from /usr/local/bin', () => {
    const binPath = '/usr/local/bin/rivethub'
    expect(resolveInstallPath(binPath, homeDir, tmpDir)).toBe(binPath)
  })

  it('rejects temp path even when tmpdir has trailing slash', () => {
    const tempPath = '/tmp/rivethub-update-abc/RivetHub.AppImage'
    expect(resolveInstallPath(tempPath, homeDir, '/tmp/')).toBe(fallback)
  })
})
