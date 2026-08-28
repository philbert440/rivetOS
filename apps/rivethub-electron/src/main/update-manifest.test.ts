import { describe, expect, it } from 'vitest'
import { newerVersion, validateManifestEntry } from './update-manifest.js'

const good = {
  version: '0.5.1',
  file: 'RivetHub-Setup-0.5.1.exe',
  sha256: 'a'.repeat(64),
  sizeBytes: 112000000,
}

describe('validateManifestEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(validateManifestEntry(good, 'win32')).toEqual(good)
  })

  it('drops a non-integer sizeBytes instead of failing', () => {
    expect(validateManifestEntry({ ...good, sizeBytes: 1.5 }, 'win32').sizeBytes).toBeUndefined()
  })

  it('refuses traversal and separators in file (the files API decodes them)', () => {
    for (const file of [
      '../elsewhere/payload.exe',
      'a/../b.exe',
      'dir/payload.exe',
      'dir\\payload.exe',
      '..',
      '.hidden.exe',
      'name%2F..%2Fpayload.exe'.replace(/%2F/g, '/'),
    ]) {
      expect(() => validateManifestEntry({ ...good, file }, 'win32')).toThrow()
    }
  })

  it('refuses malformed versions and digests', () => {
    expect(() => validateManifestEntry({ ...good, version: 'v1.2.3' }, 'win32')).toThrow()
    expect(() => validateManifestEntry({ ...good, version: '1.2' }, 'win32')).toThrow()
    expect(() => validateManifestEntry({ ...good, sha256: 'A'.repeat(64) }, 'win32')).toThrow()
    expect(() => validateManifestEntry({ ...good, sha256: 'a'.repeat(63) }, 'win32')).toThrow()
  })

  it('refuses missing/non-object entries', () => {
    for (const raw of [undefined, null, 'x', 42, []]) {
      expect(() => validateManifestEntry(raw, 'win32')).toThrow()
    }
  })
})

describe('newerVersion', () => {
  it('compares numeric triples', () => {
    expect(newerVersion('0.5.1', '0.5.0')).toBe(true)
    expect(newerVersion('0.5.0', '0.5.1')).toBe(false)
    expect(newerVersion('1.0.0', '0.9.9')).toBe(true)
    expect(newerVersion('0.5.0', '0.5.0')).toBe(false)
    expect(newerVersion('0.10.0', '0.9.0')).toBe(true)
  })

  it('ranks a release above its own prereleases (no prerelease stripping)', () => {
    expect(newerVersion('1.0.0', '1.0.0-beta')).toBe(true)
    expect(newerVersion('1.0.0-beta', '1.0.0')).toBe(false)
    expect(newerVersion('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true)
    expect(newerVersion('1.0.0-rc', '1.0.0-beta')).toBe(true)
    expect(newerVersion('1.0.0-beta.10', '1.0.0-beta.9')).toBe(true)
  })

  it('ignores build metadata and fails closed on non-semver', () => {
    expect(newerVersion('1.0.1+build5', '1.0.0')).toBe(true)
    expect(newerVersion('v1.2.3', '1.0.0')).toBe(false)
    expect(newerVersion('1.2', '1.0.0')).toBe(false)
    expect(newerVersion('1.0.0', 'junk')).toBe(false)
  })
})
