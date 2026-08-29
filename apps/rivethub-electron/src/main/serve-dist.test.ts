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

describe('isBundledUrl — both shapes the permission gates receive', () => {
  it('accepts the bare origin (check handler) and full URLs (request handler)', async () => {
    const { isBundledUrl } = await import('./serve-dist.js')
    expect(isBundledUrl('app://bundle')).toBe(true)
    expect(isBundledUrl('app://bundle/index.html')).toBe(true)
    expect(isBundledUrl('app://bundle/?q=1#h')).toBe(true)
  })

  it('rejects lookalikes, other schemes and junk', async () => {
    const { isBundledUrl } = await import('./serve-dist.js')
    expect(isBundledUrl('app://bundle.evil.com')).toBe(false)
    expect(isBundledUrl('app://evil')).toBe(false)
    expect(isBundledUrl('http://bundle')).toBe(false)
    expect(isBundledUrl('not a url')).toBe(false)
    expect(isBundledUrl('')).toBe(false)
  })
})

describe('media permission fences', () => {
  it('request: audio-only from the bundled main frame', async () => {
    const { allowMediaRequest } = await import('./serve-dist.js')
    const ok = { requestingUrl: 'app://bundle/index.html', isMainFrame: true, mediaTypes: ['audio'] }
    expect(allowMediaRequest(ok)).toBe(true)
    expect(allowMediaRequest({ ...ok, mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(allowMediaRequest({ ...ok, mediaTypes: [] })).toBe(false)
    expect(allowMediaRequest({ ...ok, mediaTypes: undefined })).toBe(false)
    expect(allowMediaRequest({ ...ok, isMainFrame: false })).toBe(false)
    expect(allowMediaRequest({ ...ok, isMainFrame: undefined })).toBe(false) // fail closed
    expect(allowMediaRequest({ ...ok, requestingUrl: 'http://192.0.2.7/den' })).toBe(false)
    expect(allowMediaRequest({ ...ok, requestingUrl: undefined })).toBe(false)
  })

  it('check: bundled main frame, bundled-or-absent embedder, never video', async () => {
    const { allowMediaCheck } = await import('./serve-dist.js')
    const main = { isMainFrame: true }
    expect(allowMediaCheck('app://bundle', { ...main, mediaType: 'audio' })).toBe(true)
    expect(allowMediaCheck('app://bundle', main)).toBe(true) // permissions.query('microphone')
    expect(allowMediaCheck('app://bundle', { ...main, embeddingOrigin: 'app://bundle' })).toBe(true)
    expect(allowMediaCheck('app://bundle', { ...main, mediaType: 'video' })).toBe(false)
    expect(allowMediaCheck('app://bundle', { ...main, embeddingOrigin: 'http://192.0.2.9' })).toBe(
      false,
    )
    expect(allowMediaCheck('http://192.0.2.9', { ...main, mediaType: 'audio' })).toBe(false)
    // a same-origin subframe keeps the parent origin and omits embeddingOrigin —
    // the frame check is what keeps the twins in agreement (#576 review)
    expect(allowMediaCheck('app://bundle', { isMainFrame: false, mediaType: 'audio' })).toBe(false)
    expect(allowMediaCheck('app://bundle', { mediaType: 'audio' })).toBe(false) // fail closed
  })
})
