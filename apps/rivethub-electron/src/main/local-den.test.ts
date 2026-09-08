import * as http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { adoptLocalDenIfUnconfigured, probeLocalDen, type ProbeGet } from './local-den.js'

const OK = JSON.stringify({ ok: true, name: 'rivet-grok', sessions: 0 })

function scriptedGet(
  script: Array<{
    statusCode?: number
    body?: string
    error?: Error
    delayMs?: number
  }>,
): ProbeGet & {
  calls: Array<{ kind: 'https' | 'http'; rejectUnauthorized: boolean; ca?: string }>
} {
  const calls: Array<{ kind: 'https' | 'http'; rejectUnauthorized: boolean; ca?: string }> = []
  let i = 0
  const get: ProbeGet = async (kind, options) => {
    calls.push({ kind, rejectUnauthorized: options.rejectUnauthorized, ca: options.ca })
    const step = script[i++] ?? {
      error: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    }
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs))
    if (step.error) throw step.error
    return { statusCode: step.statusCode ?? 200, body: step.body ?? '{"ok":true}' }
  }
  return Object.assign(get, { calls })
}

function memStore(init: Record<string, unknown> = {}): {
  get: (key: string) => unknown
  setAll: (updates: Record<string, unknown>) => void
  snapshot: () => Record<string, unknown>
} {
  const settings = { ...init }
  return {
    get: (key) => settings[key],
    setAll: (updates) => {
      Object.assign(settings, updates)
    },
    snapshot: () => ({ ...settings }),
  }
}

describe('probeLocalDen', () => {
  it('hits https /healthz and returns baseUrl + name', async () => {
    const get = scriptedGet([{ body: OK }])
    const hit = await probeLocalDen({ caPem: '-----BEGIN CERTIFICATE-----\n' }, { get })
    expect(hit).toEqual({ baseUrl: 'https://localhost:5174', name: 'rivet-grok' })
    expect(get.calls[0]).toMatchObject({
      kind: 'https',
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\n',
    })
    expect(get.calls).toHaveLength(1)
  })

  it('falls back to http when https misses', async () => {
    const get = scriptedGet([
      { error: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
      { body: JSON.stringify({ ok: true, name: 'local-box' }) },
    ])
    const hit = await probeLocalDen({}, { get })
    expect(hit).toEqual({ baseUrl: 'http://localhost:5174', name: 'local-box' })
    expect(get.calls.map((c) => c.kind)).toEqual(['https', 'http'])
    expect(get.calls[0]?.rejectUnauthorized).toBe(false)
  })

  it('returns null on miss (both transports fail)', async () => {
    const get = scriptedGet([
      { error: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
      { error: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
    ])
    expect(await probeLocalDen({}, { get })).toBeNull()
  })

  it('returns null on non-2xx, junk JSON, ok:false, and nameless healthz', async () => {
    const cases = [
      [{ statusCode: 500, body: '{"ok":true}' }],
      [{ body: 'not-json' }],
      [{ body: '{"ok":false,"name":"x"}' }],
      [{ body: '{"ok":true}' }],
      [{ body: '{"ok":true,"name":42}' }],
      [{ body: '{"ok":true,"name":""}' }],
      [{ body: '{"ok":true,"name":"   "}' }],
    ]
    for (const script of cases) {
      const get = scriptedGet(script)
      expect(await probeLocalDen({}, { get })).toBeNull()
    }
  })

  it('times out a hanging probe and stays under the ~3s cap', async () => {
    const get: ProbeGet = () => new Promise(() => {})
    const t0 = Date.now()
    const hit = await probeLocalDen({ timeoutMs: 40 }, { get })
    const elapsed = Date.now() - t0
    expect(hit).toBeNull()
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(500)
  })

  it('retries https without verifying after a bad CA, then hits', async () => {
    const certErr = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    })
    const get = scriptedGet([{ error: certErr }, { body: OK }])
    const hit = await probeLocalDen({ caPem: 'not-a-real-pem' }, { get })
    expect(hit).toEqual({ baseUrl: 'https://localhost:5174', name: 'rivet-grok' })
    expect(get.calls).toEqual([
      { kind: 'https', rejectUnauthorized: true, ca: 'not-a-real-pem' },
      { kind: 'https', rejectUnauthorized: false, ca: undefined },
    ])
  })

  it('skips insecure https after a CA-path timeout so HTTP still fits the budget', async () => {
    const get = scriptedGet([
      { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
      { body: JSON.stringify({ ok: true, name: 'plain' }) },
    ])
    const hit = await probeLocalDen({ caPem: 'ca' }, { get })
    expect(hit).toEqual({ baseUrl: 'http://localhost:5174', name: 'plain' })
    expect(get.calls.map((c) => c.kind)).toEqual(['https', 'http'])
    expect(get.calls[0]?.rejectUnauthorized).toBe(true)
  })

  it('never throws', async () => {
    const get: ProbeGet = () => {
      throw 'string-throw'
    }
    await expect(probeLocalDen({}, { get })).resolves.toBeNull()
  })

  it('aborts a trickling response at the wall-clock deadline', async () => {
    const sockets = new Set<Socket>()
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const id = setInterval(() => {
        try {
          res.write('x')
        } catch {
          /* destroyed */
        }
      }, 15)
      const stop = (): void => clearInterval(id)
      req.on('close', stop)
      res.on('close', stop)
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => {
      server.listen(0, 'localhost', () => resolve())
    })
    const addr = server.address() as AddressInfo
    try {
      const t0 = Date.now()
      const hit = await probeLocalDen({ port: addr.port, timeoutMs: 60 })
      const elapsed = Date.now() - t0
      expect(hit).toBeNull()
      expect(elapsed).toBeGreaterThanOrEqual(40)
      expect(elapsed).toBeLessThan(800)
      const drainUntil = Date.now() + 200
      while (sockets.size > 0 && Date.now() < drainUntil) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(sockets.size).toBe(0)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  })
})

describe('adoptLocalDenIfUnconfigured', () => {
  it('writes baseUrl + roster on a hit when unset', async () => {
    const store = memStore()
    const get = scriptedGet([{ body: OK }])
    const hit = await adoptLocalDenIfUnconfigured(store, { caPem: 'ca' }, { get })
    expect(hit?.baseUrl).toBe('https://localhost:5174')
    expect(store.snapshot()).toEqual({
      'rivethub.baseUrl': 'https://localhost:5174',
      'rivethub.roster': [{ name: 'rivet-grok', baseUrl: 'https://localhost:5174' }],
    })
  })

  it('does not adopt {"ok":true} without a name', async () => {
    const store = memStore()
    const get = scriptedGet([{ body: '{"ok":true}' }])
    expect(await adoptLocalDenIfUnconfigured(store, {}, { get })).toBeNull()
    expect(store.snapshot()).toEqual({})
  })

  it('writes baseUrl + roster when other settings already exist', async () => {
    const store = memStore({ 'rivethub.theme': 'dark' })
    const get = scriptedGet([{ body: OK }])
    await adoptLocalDenIfUnconfigured(store, { caPem: 'ca' }, { get })
    expect(store.snapshot()).toEqual({
      'rivethub.theme': 'dark',
      'rivethub.baseUrl': 'https://localhost:5174',
      'rivethub.roster': [{ name: 'rivet-grok', baseUrl: 'https://localhost:5174' }],
    })
  })

  it('does not clobber an existing roster entry with the same baseUrl', async () => {
    const store = memStore({
      'rivethub.roster': [{ name: 'already', baseUrl: 'https://localhost:5174' }],
    })
    const get = scriptedGet([{ body: OK }])
    await adoptLocalDenIfUnconfigured(store, { caPem: 'ca' }, { get })
    expect(store.snapshot()['rivethub.roster']).toEqual([
      { name: 'already', baseUrl: 'https://localhost:5174' },
    ])
    expect(store.snapshot()['rivethub.baseUrl']).toBe('https://localhost:5174')
  })

  it('appends a new roster row when the adopted baseUrl is not present', async () => {
    const store = memStore({
      'rivethub.roster': [{ name: 'other', baseUrl: 'https://other:5174' }],
    })
    const get = scriptedGet([{ body: OK }])
    await adoptLocalDenIfUnconfigured(store, { caPem: 'ca' }, { get })
    expect(store.snapshot()['rivethub.roster']).toEqual([
      { name: 'other', baseUrl: 'https://other:5174' },
      { name: 'rivet-grok', baseUrl: 'https://localhost:5174' },
    ])
  })

  it('does nothing when rivethub.baseUrl is already set', async () => {
    const store = memStore({ 'rivethub.baseUrl': 'https://hub.example:5174' })
    const get = scriptedGet([{ body: OK }])
    expect(await adoptLocalDenIfUnconfigured(store, {}, { get })).toBeNull()
    expect(get.calls).toHaveLength(0)
    expect(store.snapshot()).toEqual({ 'rivethub.baseUrl': 'https://hub.example:5174' })
  })

  it('treats whitespace-only baseUrl as unset', async () => {
    const store = memStore({ 'rivethub.baseUrl': '  ' })
    const get = scriptedGet([{ body: OK }])
    await adoptLocalDenIfUnconfigured(store, { caPem: 'ca' }, { get })
    expect(store.snapshot()['rivethub.baseUrl']).toBe('https://localhost:5174')
  })

  it('does not write on a miss', async () => {
    const store = memStore()
    const get = scriptedGet([{ error: new Error('down') }, { error: new Error('down') }])
    expect(await adoptLocalDenIfUnconfigured(store, {}, { get })).toBeNull()
    expect(store.snapshot()).toEqual({})
  })
})
