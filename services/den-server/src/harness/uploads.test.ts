// Harness attachment staging (POST /api/uploads).
//
// The route half runs over a bare node:http server so the cap/traversal/TTL
// cases stay fast; the auth half runs over a real den server with a bearer
// token set, because "same gate as every other /api route" is the claim being
// tested and only the real server can prove it.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDenServer, type DenServer } from '../server.js'
import type { DenConfig } from '../config.js'
import {
  createUploadRoutes,
  displayName,
  safeExtension,
  safeMime,
  stagedFileName,
  type UploadRoutes,
} from './uploads.js'

const dirs: string[] = []
const servers: Server[] = []
const dens: DenServer[] = []
const routes: UploadRoutes[] = []

afterEach(async () => {
  routes.splice(0).forEach((r) => r.close())
  await Promise.all(dens.splice(0).map((d) => d.close()))
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  )
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

interface Harness {
  base: string
  dir: string
  routes: UploadRoutes
}

function start(opts: { maxBytes?: number; ttlMs?: number; now?: () => number } = {}): Promise<Harness> {
  const root = tempDir('den-uploads-')
  const dir = join(root, 'uploads')
  const r = createUploadRoutes({
    dir,
    // no periodic timer in tests — sweeps are driven explicitly
    sweepIntervalMs: 0,
    ...opts,
  })
  routes.push(r)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!r.handle(req, res, url)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":"not found"}')
    }
  })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ base: `http://127.0.0.1:${String(port)}`, dir, routes: r })
    })
  })
}

// -- sanitizers ---------------------------------------------------------------

describe('upload name sanitizers', () => {
  it('reduces a client name to one displayable segment', () => {
    expect(displayName('shot.png')).toBe('shot.png')
    expect(displayName('../../../etc/passwd')).toBe('passwd')
    expect(displayName('C:\\Users\\me\\shot.png')).toBe('shot.png')
    expect(displayName('a/b/c.txt')).toBe('c.txt')
    expect(displayName('with\u0000nul.txt')).toBe('withnul.txt')
    expect(displayName('..')).toBe('')
    expect(displayName('.')).toBe('')
    expect(displayName('')).toBe('')
    expect(displayName('/')).toBe('')
    expect(displayName('x'.repeat(400))).toHaveLength(128)
  })

  it('only honors a short alphanumeric extension', () => {
    expect(safeExtension('shot.PNG')).toBe('.png')
    expect(safeExtension('archive.tar.gz')).toBe('.gz')
    expect(safeExtension('../../etc/passwd')).toBe('')
    expect(safeExtension('noext')).toBe('')
    expect(safeExtension('.bashrc')).toBe('') // leading dot is not an extension
    expect(safeExtension('trailing.')).toBe('')
    expect(safeExtension(`long.${'a'.repeat(20)}`)).toBe('')
    expect(safeExtension('weird.p n g')).toBe('')
  })

  it('builds an on-disk name from the id, never the client text', () => {
    expect(stagedFileName('../../../etc/passwd', 'ID')).toBe('ID')
    expect(stagedFileName('a/b/shot.png', 'ID')).toBe('ID.png')
    expect(stagedFileName('shot.png/../../evil', 'ID')).toBe('ID')
  })

  it('normalizes media types and refuses junk', () => {
    expect(safeMime('image/png')).toBe('image/png')
    expect(safeMime('TEXT/Plain; charset=utf-8')).toBe('text/plain')
    expect(safeMime('application/vnd.api+json')).toBe('application/vnd.api+json')
    expect(safeMime('not-a-mime')).toBe('')
    expect(safeMime('image/<script>')).toBe('')
    expect(safeMime(undefined)).toBe('')
  })
})

// -- route --------------------------------------------------------------------

describe('POST /api/uploads', () => {
  it('stages bytes and returns a node-local uri under the staging dir', async () => {
    const { base, dir } = await start()
    const res = await fetch(`${base}/api/uploads?name=shot.png`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: 'PNGDATA',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      uri: string
      name: string
      mime: string
      size: number
      expiresAt: string
    }
    expect(body.name).toBe('shot.png')
    expect(body.mime).toBe('image/png')
    expect(body.size).toBe(7)
    expect(body.uri.startsWith(`${dir}/`)).toBe(true)
    expect(body.uri.endsWith('.png')).toBe(true)
    // the generated name is a uuid, not the client's
    expect(body.uri).not.toContain('shot')
    expect(readFileSync(body.uri, 'utf8')).toBe('PNGDATA')
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now())
    // committed, no .part litter
    expect(readdirSync(dir).filter((n) => n.endsWith('.part'))).toEqual([])
    // 0600 on the file, 0700 on the dir
    expect(statSync(body.uri).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('falls back to the extension, then octet-stream, for the media type', async () => {
    const { base } = await start()
    // a BufferSource body sends no Content-Type, so the extension decides
    const pdf = await fetch(`${base}/api/uploads?name=paper.pdf`, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    })
    expect(((await pdf.json()) as { mime: string }).mime).toBe('application/pdf')
    const blob = await fetch(`${base}/api/uploads?name=blob.bin`, {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    })
    expect(((await blob.json()) as { mime: string }).mime).toBe('application/octet-stream')
    // a real Content-Type outranks the extension
    const typed = await fetch(`${base}/api/uploads?name=notes.txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(((await typed.json()) as { mime: string }).mime).toBe('application/json')
    // an explicit ?mime= wins over the Content-Type header
    const forced = await fetch(`${base}/api/uploads?name=x.bin&mime=image/webp`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'x',
    })
    expect(((await forced.json()) as { mime: string }).mime).toBe('image/webp')
  })

  it('confines traversal attempts to the staging dir', async () => {
    const { base, dir } = await start()
    const outside = join(dir, '..', 'pwned.txt')
    for (const name of [
      '../../../../tmp/pwned.txt',
      '..%2F..%2Fpwned.txt',
      '/etc/pwned.txt',
      '..',
      'sub/dir/pwned.txt',
    ]) {
      const res = await fetch(`${base}/api/uploads?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        body: 'owned',
      })
      expect(res.status).toBe(201)
      const { uri } = (await res.json()) as { uri: string }
      expect(uri.startsWith(`${dir}/`)).toBe(true)
      expect(uri.slice(dir.length + 1)).not.toContain('/')
    }
    expect(existsSync(outside)).toBe(false)
    // one flat file per upload, nothing nested
    const entries = readdirSync(dir, { withFileTypes: true })
    expect(entries).toHaveLength(5)
    expect(entries.every((e) => e.isFile())).toBe(true)
  })

  it('names a nameless upload after its generated id', async () => {
    const { base, dir } = await start()
    const res = await fetch(`${base}/api/uploads`, { method: 'POST', body: 'x' })
    const { uri, name } = (await res.json()) as { uri: string; name: string }
    expect(name).toBe(uri.slice(dir.length + 1))
  })

  it('refuses an oversize declared body before reading it', async () => {
    const { base, dir } = await start({ maxBytes: 16 })
    const res = await fetch(`${base}/api/uploads?name=big.bin`, {
      method: 'POST',
      body: 'x'.repeat(64),
    })
    expect(res.status).toBe(413)
    // refused before the staging dir was even created
    expect(existsSync(dir)).toBe(false)
  })

  // Looped on purpose: the abort path used to race createWriteStream's lazy
  // open, and the pending O_CREAT would recreate the .part file a beat after
  // the unlink. It reproduced roughly one run in five, which is exactly the
  // kind of test that reddens CI for an unrelated PR. Twenty-five passes cost
  // milliseconds and pin the synchronous-open fix down.
  it('refuses an oversize streamed body mid-flight and leaves no partial', async () => {
    const { base, dir } = await start({ maxBytes: 32 })
    for (let attempt = 0; attempt < 25; attempt++) {
      // chunked (no Content-Length) — the cap must hold on the data path too
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(16))
          controller.close()
        },
      })
      const res = await fetch(`${base}/api/uploads?name=stream.bin`, {
        method: 'POST',
        body,
        // undici requires this for a stream body
        duplex: 'half',
      } as RequestInit & { duplex: 'half' })
      // the client gets a real 413, not a socket error: the response is
      // flushed before the connection is torn down
      expect(res.status).toBe(413)
      // and the half-written .part goes with it — no orphan, ever
      expect(readdirSync(dir)).toEqual([])
    }
  })

  it('refuses an empty body and other methods', async () => {
    const { base, dir } = await start()
    const empty = await fetch(`${base}/api/uploads?name=x.txt`, { method: 'POST', body: '' })
    expect(empty.status).toBe(400)
    expect(readdirSync(dir)).toEqual([])
    const get = await fetch(`${base}/api/uploads`)
    expect(get.status).toBe(405)
  })

  it('404s a sub-path — /api/uploads is the whole surface', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/api/uploads/nope`, { method: 'POST', body: 'x' })
    expect(res.status).toBe(404)
  })
})

// -- retention ----------------------------------------------------------------

describe('staged upload TTL sweep', () => {
  it('unlinks staged files past the TTL and keeps fresh ones', async () => {
    const { base, dir, routes: r } = await start({ ttlMs: 60_000 })
    const fresh = (await (
      await fetch(`${base}/api/uploads?name=new.txt`, { method: 'POST', body: 'new' })
    ).json()) as { uri: string }
    const stale = (await (
      await fetch(`${base}/api/uploads?name=old.txt`, { method: 'POST', body: 'old' })
    ).json()) as { uri: string }
    const longAgo = new Date(Date.now() - 3_600_000)
    utimesSync(stale.uri, longAgo, longAgo)
    // an orphaned partial from a dropped connection is reaped on the same rule
    const orphan = join(dir, 'orphan.bin.part')
    writeFileSync(orphan, 'half')
    utimesSync(orphan, longAgo, longAgo)

    expect(r.sweep()).toBe(2)
    expect(existsSync(stale.uri)).toBe(false)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(fresh.uri)).toBe(true)
  })

  it('never follows or removes a symlink planted in the staging dir', async () => {
    const outsideRoot = tempDir('den-uploads-victim-')
    const victim = join(outsideRoot, 'secret.txt')
    writeFileSync(victim, 'do not touch')
    const { base, dir, routes: r } = await start({ ttlMs: 60_000 })
    // force the dir into existence before planting the links
    const staged = (await (
      await fetch(`${base}/api/uploads?name=x.txt`, { method: 'POST', body: 'x' })
    ).json()) as { uri: string }
    const link = join(dir, 'link.txt')
    symlinkSync(victim, link)
    const dirLink = join(dir, 'dirlink')
    symlinkSync(outsideRoot, dirLink, 'dir')
    // everything in sight is stale: the staged file, the link, and the target
    const longAgo = new Date(Date.now() - 3_600_000)
    utimesSync(victim, longAgo, longAgo)
    utimesSync(staged.uri, longAgo, longAgo)

    // only the real staged file goes
    expect(r.sweep()).toBe(1)
    expect(existsSync(staged.uri)).toBe(false)
    expect(existsSync(victim)).toBe(true)
    expect(readFileSync(victim, 'utf8')).toBe('do not touch')
    // the links themselves are left alone — the sweep only unlinks regular files
    expect(readdirSync(dir).sort()).toEqual(['dirlink', 'link.txt'])
  })

  it('sweeps on construction, so a node down past the TTL boots clean', () => {
    const root = tempDir('den-uploads-boot-')
    const dir = join(root, 'uploads')
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'yesterday.png')
    writeFileSync(old, 'stale')
    const longAgo = new Date(Date.now() - 86_400_000)
    utimesSync(old, longAgo, longAgo)
    const r = createUploadRoutes({ dir, ttlMs: 60_000, sweepIntervalMs: 0 })
    routes.push(r)
    expect(existsSync(old)).toBe(false)
  })

  it('ttlMs=0 disables retention entirely', async () => {
    const { base, routes: r } = await start({ ttlMs: 0 })
    const res = await fetch(`${base}/api/uploads?name=keep.txt`, { method: 'POST', body: 'keep' })
    const body = (await res.json()) as { uri: string; expiresAt?: string }
    expect(body.expiresAt).toBeUndefined()
    const longAgo = new Date(Date.now() - 86_400_000)
    utimesSync(body.uri, longAgo, longAgo)
    expect(r.sweep()).toBe(0)
    expect(existsSync(body.uri)).toBe(true)
  })
})

// -- auth ---------------------------------------------------------------------

function denConfig(stateDir: string, token: string): DenConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    token,
    stateDir,
    staticDir: '',
    packsDir: '',
    rootRedirect: '',
    evictTtlMs: 60_000,
    meshFile: '',
    meshCacheMs: 10_000,
    term: {
      enabled: false,
      open: false,
      configFile: join(stateDir, 'den-term.json'),
      maxPtys: 4,
      scrollbackBytes: 262_144,
      detachedTtlMs: 1_800_000,
      idleTtlMs: 1_800_000,
      exitLingerMs: 60_000,
      injectReadyMs: 10,
    },
    audio: { enabled: false, open: false, dir: '', deviceName: 'RivetHub Mic', sampleRate: 16_000 },
    filesRoot: '',
    filesOpen: false,
  }
}

describe('upload auth', () => {
  it('rides the den server bearer gate like every other /api route', async () => {
    const stateDir = tempDir('den-uploads-auth-')
    const den = createDenServer(denConfig(stateDir, 'sekrit'), {
      ptySpawn: null,
      skipBuiltinHarnessDrivers: true,
    })
    dens.push(den)
    await new Promise<void>((resolve) => den.server.listen(0, '127.0.0.1', () => resolve()))
    const { port } = den.server.address() as AddressInfo
    const base = `http://127.0.0.1:${String(port)}`

    const anon = await fetch(`${base}/api/uploads?name=x.txt`, { method: 'POST', body: 'x' })
    expect(anon.status).toBe(401)
    expect(existsSync(join(stateDir, 'uploads'))).toBe(false)

    const wrong = await fetch(`${base}/api/uploads?name=x.txt`, {
      method: 'POST',
      body: 'x',
      headers: { Authorization: 'Bearer nope' },
    })
    expect(wrong.status).toBe(401)

    const ok = await fetch(`${base}/api/uploads?name=x.txt`, {
      method: 'POST',
      body: 'hello',
      headers: { Authorization: 'Bearer sekrit' },
    })
    expect(ok.status).toBe(201)
    const { uri } = (await ok.json()) as { uri: string }
    expect(uri.startsWith(join(stateDir, 'uploads'))).toBe(true)
    expect(readFileSync(uri, 'utf8')).toBe('hello')
  })
})
