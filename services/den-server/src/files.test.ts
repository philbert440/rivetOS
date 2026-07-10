import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFilesRoutes, resolveFenced, safeName } from './files.js'

describe('resolveFenced', () => {
  const root = '/srv/shared'
  it('resolves relative paths under the root', () => {
    expect(resolveFenced(root, '')).toBe(root)
    expect(resolveFenced(root, 'a/b.txt')).toBe('/srv/shared/a/b.txt')
  })
  it('refuses escapes and absolute/backslash/NUL paths', () => {
    expect(resolveFenced(root, '..')).toBeNull()
    expect(resolveFenced(root, 'a/../../etc/passwd')).toBeNull()
    expect(resolveFenced(root, '/etc/passwd')).toBeNull()
    expect(resolveFenced(root, '~root')).toBeNull()
    expect(resolveFenced(root, 'a\\b')).toBeNull()
    expect(resolveFenced(root, 'a\0b')).toBeNull()
  })
  it('refuses the sibling-prefix trick (/srv/shared-evil)', () => {
    expect(resolveFenced(root, '../shared-evil/x')).toBeNull()
  })
})

describe('safeName', () => {
  it('accepts plain names, refuses traversal and separators', () => {
    expect(safeName('notes.md')).toBe('notes.md')
    expect(safeName('..')).toBeNull()
    expect(safeName('a/b')).toBeNull()
    expect(safeName('')).toBeNull()
  })
})

describe('files routes', () => {
  let root: string
  let server: Server
  let base: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'den-files-'))
    mkdirSync(join(root, 'plans'))
    writeFileSync(join(root, 'plans', 'a.md'), 'hello')
    writeFileSync(join(root, 'top.txt'), 'top')
    symlinkSync('/etc/hostname', join(root, 'leak.txt'))
    const routes = createFilesRoutes({ root })
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!routes.handle(req, res, url)) {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterAll(async () => {
    await new Promise((r) => server.close(r))
    rmSync(root, { recursive: true, force: true })
  })

  it('lists the root, dirs first', async () => {
    const res = await fetch(`${base}/files/list?path=`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string; entries: { name: string; type: string }[] }
    expect(body.path).toBe('')
    expect(body.entries[0]).toMatchObject({ name: 'plans', type: 'dir' })
    expect(body.entries.map((e) => e.name)).toContain('top.txt')
  })

  it('lists a subdirectory and 403s an escape', async () => {
    const sub = await fetch(`${base}/files/list?path=plans`)
    expect(((await sub.json()) as { entries: unknown[] }).entries).toHaveLength(1)
    expect((await fetch(`${base}/files/list?path=../`)).status).toBe(403)
    expect((await fetch(`${base}/files/list?path=%2Fetc`)).status).toBe(403)
  })

  it('downloads a file inline with its type', async () => {
    const res = await fetch(`${base}/files/download?path=plans/a.md`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
    expect(res.headers.get('content-disposition')).toContain('inline')
  })

  it('refuses downloading through a symlink that leaves the root', async () => {
    expect((await fetch(`${base}/files/download?path=leak.txt`)).status).toBe(403)
  })

  it('uploads, no-clobbers, then overwrites with the flag', async () => {
    const up = await fetch(`${base}/files/upload?dir=plans&name=new.txt`, {
      method: 'POST',
      body: 'first',
    })
    expect(up.status).toBe(200)
    expect(readFileSync(join(root, 'plans', 'new.txt'), 'utf8')).toBe('first')

    const clash = await fetch(`${base}/files/upload?dir=plans&name=new.txt`, {
      method: 'POST',
      body: 'second',
    })
    expect(clash.status).toBe(409)

    const force = await fetch(`${base}/files/upload?dir=plans&name=new.txt&overwrite=1`, {
      method: 'POST',
      body: 'second',
    })
    expect(force.status).toBe(200)
    expect(readFileSync(join(root, 'plans', 'new.txt'), 'utf8')).toBe('second')
  })

  it('rejects bad upload names and escaping dirs', async () => {
    expect(
      (await fetch(`${base}/files/upload?dir=plans&name=..`, { method: 'POST', body: 'x' }))
        .status,
    ).toBe(422)
    expect(
      (await fetch(`${base}/files/upload?dir=..&name=ok.txt`, { method: 'POST', body: 'x' }))
        .status,
    ).toBe(403)
    expect(
      (await fetch(`${base}/files/upload?dir=nope&name=ok.txt`, { method: 'POST', body: 'x' }))
        .status,
    ).toBe(404)
  })
})
