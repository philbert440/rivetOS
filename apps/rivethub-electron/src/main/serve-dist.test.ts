import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { resolveAsset } from './serve-dist.js'

const DIST = path.normalize('/srv/web/dist')

describe('resolveAsset', () => {
  it('serves index.html for the root and router paths', () => {
    expect(resolveAsset(DIST, '/')).toEqual({
      file: path.join(DIST, 'index.html'),
      mime: 'text/html; charset=utf-8',
    })
    expect(resolveAsset(DIST, '/memory')?.file).toBe(path.join(DIST, 'index.html'))
    expect(resolveAsset(DIST, '')?.file).toBe(path.join(DIST, 'index.html'))
  })

  it('maps asset extensions to mime types', () => {
    expect(resolveAsset(DIST, '/assets/app.js')?.mime).toBe('text/javascript')
    expect(resolveAsset(DIST, '/assets/app.css')?.mime).toBe('text/css')
    expect(resolveAsset(DIST, '/den/index.html')?.file).toBe(path.join(DIST, 'den/index.html'))
    expect(resolveAsset(DIST, '/font.woff2')?.mime).toBe('font/woff2')
    expect(resolveAsset(DIST, '/blob.unknownext')?.mime).toBe('application/octet-stream')
  })

  it('fences directory traversal', () => {
    expect(resolveAsset(DIST, '/../secrets.txt')).toBeNull()
    expect(resolveAsset(DIST, '/%2e%2e/secrets.txt')).toBeNull()
    expect(resolveAsset(DIST, '/a/../../../etc/passwd.txt')).toBeNull()
    // extensionless traversal degrades to the SPA fallback, never escapes
    expect(resolveAsset(DIST, '/a/../../../etc/passwd')?.file).toBe(path.join(DIST, 'index.html'))
    // normalizing INSIDE the root is fine
    expect(resolveAsset(DIST, '/assets/../index.html')?.file).toBe(path.join(DIST, 'index.html'))
  })

  it('ignores query strings', () => {
    expect(resolveAsset(DIST, '/index.html?x=1')?.file).toBe(path.join(DIST, 'index.html'))
  })

  it('refuses malformed escapes instead of throwing', () => {
    expect(resolveAsset(DIST, '/%zz')).toBeNull()
    expect(resolveAsset(DIST, '/a/%e0%zz/b')).toBeNull()
  })

  it('trailing-slash directories get their OWN index.html, not the SPA', () => {
    // the den viewer is nested at /den/ — it must not land on the hub SPA
    expect(resolveAsset(DIST, '/den/')?.file).toBe(path.join(DIST, 'den/index.html'))
    expect(resolveAsset(DIST, '/den/sub/')?.file).toBe(path.join(DIST, 'den/sub/index.html'))
  })
})
