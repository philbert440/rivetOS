import { describe, expect, it } from 'vitest'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CSP, resolveAsset, serveDist, snapshotDist } from './serve-dist.js'

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
    expect(resolveAsset(DIST, '/nested/index.html')?.file).toBe(
      path.join(DIST, 'nested/index.html'),
    )
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

  it('extension-less paths including /den/ fall back to the hub SPA', () => {
    expect(resolveAsset(DIST, '/den/')?.file).toBe(path.join(DIST, 'index.html'))
    expect(resolveAsset(DIST, '/den')?.file).toBe(path.join(DIST, 'index.html'))
    expect(resolveAsset(DIST, '/settings/')?.file).toBe(path.join(DIST, 'index.html'))
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
    const ok = {
      requestingUrl: 'app://bundle/index.html',
      isMainFrame: true,
      mediaTypes: ['audio'],
    }
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

describe('serveDist — the dist directory vanishing under a running app', () => {
  // A second launch of the same AppImage under APPIMAGE_EXTRACT_AND_RUN
  // deletes the shared extraction dir on exit (reproduced on 0.5.16: every
  // window opened afterwards read "not found"). Real files, real deletion.
  const { mkdtemp, mkdir, writeFile, rm } = fsp
  type Handler = (req: Request) => Promise<Response>

  async function makeDist(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rh-dist-'))
    await mkdir(path.join(dir, 'assets'))
    await writeFile(path.join(dir, 'index.html'), '<html>hub</html>')
    await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log(1)')
    return dir
  }

  function register(dir: string, opts?: Parameters<typeof serveDist>[2]): Handler {
    let handler: Handler | undefined
    serveDist({ handle: (_scheme, h) => (handler = h) }, dir, opts)
    if (!handler) throw new Error('handler not registered')
    return handler
  }

  it('snapshot: serves index.html and assets after the directory is deleted', async () => {
    const dir = await makeDist()
    const handler = register(dir, { snapshot: true })
    await rm(dir, { recursive: true, force: true })

    const index = await handler(new Request('app://bundle/'))
    expect(index.status).toBe(200)
    expect(await index.text()).toBe('<html>hub</html>')
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(index.headers.get('content-security-policy')).toBe(CSP)

    const js = await handler(new Request('app://bundle/assets/app.js'))
    expect(js.status).toBe(200)
    expect(await js.text()).toBe('console.log(1)')
    expect(js.headers.get('content-type')).toBe('text/javascript')

    // A hashed asset that never existed still 404s — the snapshot is not a
    // soft-serve-index fallback (stale-tab semantics unchanged).
    const missing = await handler(new Request('app://bundle/assets/gone.js'))
    expect(missing.status).toBe(404)
  })

  it('no snapshot (dev): reads the disk, so the deletion is visible', async () => {
    const dir = await makeDist()
    const handler = register(dir)
    expect((await handler(new Request('app://bundle/'))).status).toBe(200)
    await rm(dir, { recursive: true, force: true })
    expect((await handler(new Request('app://bundle/'))).status).toBe(404)
  })

  it('snapshot failure is reported and falls back to the disk', async () => {
    const dir = await makeDist()
    const errors: unknown[] = []
    const handler = register(path.join(dir, 'does-not-exist'), {
      snapshot: true,
      onError: (e) => errors.push(e),
    })
    expect((await handler(new Request('app://bundle/'))).status).toBe(404)
    expect(errors).toHaveLength(1)
    // ...and a dist that exists on disk but failed to snapshot still serves.
    const ok = register(dir, { snapshot: true })
    expect((await ok(new Request('app://bundle/'))).status).toBe(200)
    await rm(dir, { recursive: true, force: true })
  })

  it('snapshotDist keys every file by normalized absolute path', async () => {
    const dir = await makeDist()
    const files = await snapshotDist(dir)
    expect([...files.keys()].sort()).toEqual([
      path.join(dir, 'assets', 'app.js'),
      path.join(dir, 'index.html'),
    ])
    await rm(dir, { recursive: true, force: true })
  })
})
