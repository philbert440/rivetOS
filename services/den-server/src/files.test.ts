import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs'
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
    writeFileSync(join(root, 'page.html'), '<script>alert(1)</script>')
    symlinkSync('/etc/hostname', join(root, 'leak.txt'))
    symlinkSync('/etc', join(root, 'evil'), 'dir')
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
    const names = body.entries.map((e) => e.name)
    expect(body.entries.find((e) => e.name === 'plans')).toMatchObject({ type: 'dir' })
    expect(names).toContain('top.txt')
    // dirs sort before files
    expect(names.indexOf('plans')).toBeLessThan(names.indexOf('top.txt'))
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

  it('refuses listing/uploading through a symlinked dir that leaves the root', async () => {
    expect((await fetch(`${base}/files/list?path=evil`)).status).toBe(403)
    expect(
      (await fetch(`${base}/files/upload?dir=evil&name=x.txt`, { method: 'POST', body: 'x' }))
        .status,
    ).toBe(403)
  })

  it('never serves HTML inline (stored-XSS fence)', async () => {
    const res = await fetch(`${base}/files/download?path=page.html`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('never renames a truncated body into place, and leaves no temp litter', async () => {
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((resolve) => {
      const sock = connect(port, '127.0.0.1', () => {
        // declare 10 bytes, send 3, hang up mid-body
        sock.write(
          'POST /files/upload?dir=plans&name=trunc.txt HTTP/1.1\r\n' +
            'Host: t\r\nContent-Length: 10\r\n\r\nabc',
        )
        setTimeout(() => {
          sock.destroy()
          resolve()
        }, 150)
      })
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(existsSync(join(root, 'plans', 'trunc.txt'))).toBe(false)
    expect(readdirSync(join(root, 'plans')).some((n) => n.includes('.part-'))).toBe(false)
  })

  it('hides in-flight upload temp names from listings', async () => {
    writeFileSync(join(root, 'plans', '.x.txt.part-123-456'), 'partial')
    const res = await fetch(`${base}/files/list?path=plans`)
    const body = (await res.json()) as { entries: { name: string }[] }
    expect(body.entries.some((e) => e.name.includes('.part-'))).toBe(false)
    rmSync(join(root, 'plans', '.x.txt.part-123-456'))
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
