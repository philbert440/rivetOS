import { describe, expect, it } from 'vitest'
import { validateUpdateRequest } from './update-validate.js'

const good = {
  url: 'http://127.0.0.1:39231/api/files/download?path=builds%2Frivethub%2FRivetHub-Setup-0.5.1.exe',
  version: '0.5.1',
  sha256: 'a'.repeat(64),
}

describe('validateUpdateRequest', () => {
  it('accepts a loopback-pipe request', () => {
    expect(validateUpdateRequest(good)).toEqual(good)
  })

  it('refuses non-loopback and non-http URLs', () => {
    for (const url of [
      'https://127.0.0.1:1234/x', // wrong scheme — pipes are plain http
      'http://192.0.2.10:1234/x', // not loopback
      'http://localhost:1234/x', // name, not the literal pipe address
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(() => validateUpdateRequest({ ...good, url })).toThrow()
    }
  })

  it('refuses malformed versions and digests', () => {
    expect(() => validateUpdateRequest({ ...good, version: 'v1.2' })).toThrow()
    expect(() => validateUpdateRequest({ ...good, version: '1.2.3; rm -rf /' })).toThrow()
    expect(() => validateUpdateRequest({ ...good, sha256: 'A'.repeat(64) })).toThrow()
    expect(() => validateUpdateRequest({ ...good, sha256: 'a'.repeat(63) })).toThrow()
  })

  it('refuses non-object payloads', () => {
    for (const raw of [null, undefined, 'x', 42, []]) {
      expect(() => validateUpdateRequest(raw)).toThrow()
    }
  })
})
