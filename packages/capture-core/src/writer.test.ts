import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCaptureWriter } from './writer.js'
import { spoolBatch } from './spool.js'
import type { CaptureBatch, CaptureMessage, CaptureWriterOptions } from './types.js'

const REDACTION_ENV = 'RIVETOS_CAPTURE_REDACTION'
let previousRedactionEnv: string | undefined
beforeEach(() => {
  previousRedactionEnv = process.env[REDACTION_ENV]
  delete process.env[REDACTION_ENV]
})
afterEach(() => {
  if (previousRedactionEnv === undefined) delete process.env[REDACTION_ENV]
  else process.env[REDACTION_ENV] = previousRedactionEnv
})

const batch: CaptureBatch = {
  session_key: 'codex:s',
  agent: 'rivet',
  messages: [{ event_id: 'e', role: 'user', content: 'hello' }],
}
const result = { ok: true, conversation_id: 'c', inserted: 1, skipped: 0 }
const DEFAULT_LIMIT = 768 * 1024
const dirs: string[] = []
const spoolLimit = new Map<string, number>()
function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
async function setup(fetch: typeof globalThis.fetch, extra?: Partial<CaptureWriterOptions>) {
  const spoolDir = await mkdtemp(join(tmpdir(), 'capture-'))
  dirs.push(spoolDir)
  const requested = extra?.maxChunkBytes ?? DEFAULT_LIMIT
  const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_LIMIT
  spoolLimit.set(spoolDir, limit)
  return {
    spoolDir,
    writer: createCaptureWriter({
      denUrl: 'https://localhost:5174/',
      fetch,
      spoolDir,
      now: () => new Date(1000),
      ...extra,
    }),
  }
}
function okResult(inserted: number, skipped = 0) {
  return { ok: true as const, conversation_id: 'c', inserted, skipped }
}
async function assertSpoolWithinLimit(dir: string, maxBytes: number): Promise<void> {
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const body = await readFile(join(dir, name))
    expect(body.byteLength).toBeLessThanOrEqual(maxBytes)
  }
}
afterEach(async () => {
  await Promise.all(
    [...spoolLimit.entries()].map(async ([dir, limit]) => assertSpoolWithinLimit(dir, limit)),
  )
  spoolLimit.clear()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('capture writer', () => {
  it('posts the exact batch and returns the result', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(result))
    const { writer } = await setup(fetch)
    expect(await writer.write(batch)).toEqual(result)
    expect(fetch).toHaveBeenCalledWith('https://localhost:5174/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    })
  })
  it.each(['network', 'server'])(
    'spools exact JSON with private permissions on %s failure',
    async (failure) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      if (failure === 'network') fetch.mockRejectedValue(new Error('offline'))
      else fetch.mockResolvedValue(new Response('', { status: 503 }))
      const { writer, spoolDir } = await setup(fetch)
      const saved = await writer.write(batch)
      expect(saved).toMatchObject({ spooled: true })
      if (!('spooled' in saved) || !saved.spooled) throw new Error('expected spool')
      expect(saved.file).toMatch(/1000-.*\.json$/)
      expect(await readFile(saved.file, 'utf8')).toBe(JSON.stringify(batch))
      expect((await stat(saved.file)).mode & 0o777).toBe(0o600)
      expect(await readdir(spoolDir)).toHaveLength(1)
    },
  )
  it.each(['network', 'server'])(
    'returns explicit failure when %s and spooling fail',
    async (failure) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      if (failure === 'network') fetch.mockRejectedValue(new Error('offline'))
      else fetch.mockResolvedValue(new Response('', { status: 503 }))
      const { spoolDir: parent } = await setup(fetch)
      const spoolDir = join(parent, 'not-a-directory')
      await writeFile(spoolDir, 'blocked')
      const log = vi.fn()
      const writer = createCaptureWriter({ denUrl: 'https://localhost:5174', fetch, spoolDir, log })
      const failed = await writer.write(batch)
      expect(failed).toEqual({
        spooled: false,
        error: expect.stringContaining('capture spool failed; batch was not saved:'),
      })
      if (!('spooled' in failed) || failed.spooled) throw new Error('expected spool failure')
      expect(failed.error).toContain(spoolDir)
      expect(log).toHaveBeenCalledWith(failed.error)
      expect(log).toHaveBeenCalledWith(
        failure === 'network' ? 'Error: offline' : 'Error: capture HTTP 503',
      )
      expect(fetch).toHaveBeenCalledOnce()
      expect(await readFile(spoolDir, 'utf8')).toBe('blocked')
      expect(await readdir(parent)).toEqual(['not-a-directory'])
    },
  )
  it.each([400, 401, 403, 405, 413, 429])('throws on %s without spooling', async (status) => {
    const { writer, spoolDir } = await setup(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('', { status })),
    )
    await expect(writer.write(batch)).rejects.toThrow(String(status))
    expect(await readdir(spoolDir)).toEqual([])
  })
  it('replays oldest first, respects the limit, and dead-letters 4xx', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(result))
      .mockResolvedValueOnce(new Response('', { status: 400 }))
      .mockResolvedValue(Response.json(result))
    const { writer, spoolDir } = await setup(fetch)
    for (const time of [30, 10, 20])
      await spoolBatch(spoolDir, { ...batch, session_key: String(time) }, new Date(time))
    expect(await writer.replay({ max: 2 })).toEqual({ replayed: 1, dead: 1, remaining: 1 })
    expect(fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).session_key)).toEqual([
      '10',
      '20',
    ])
    expect(await readdir(join(spoolDir, 'dead'))).toHaveLength(1)
    expect(await writer.replay()).toEqual({ replayed: 1, dead: 0, remaining: 0 })
  })
  it.each(['network', 'server'])(
    'stops replay on %s failure and keeps the files',
    async (failure) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      if (failure === 'network') fetch.mockRejectedValue(new Error('offline'))
      else fetch.mockResolvedValue(new Response('', { status: 500 }))
      const { writer, spoolDir } = await setup(fetch)
      await spoolBatch(spoolDir, batch, new Date(1))
      await spoolBatch(spoolDir, batch, new Date(2))
      expect(await writer.replay()).toEqual({ replayed: 0, remaining: 2, dead: 0 })
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )
  it('drains up to 50 pending files before the new write', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json(result))
    const { writer, spoolDir } = await setup(fetch)
    for (let i = 0; i < 51; i++)
      await spoolBatch(spoolDir, { ...batch, session_key: String(i) }, new Date(i))
    await writer.write(batch)
    expect(fetch).toHaveBeenCalledTimes(51)
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).session_key).toBe('0')
    expect(JSON.parse(String(fetch.mock.calls[50][1]?.body))).toEqual(batch)
    expect(await readdir(spoolDir)).toHaveLength(1)
  })

  it('packs chunks at the byte limit, never over, and finalizes only the last', async () => {
    const messages: CaptureMessage[] = [1, 2, 3, 4].map((n) => ({
      event_id: `e${String(n)}`,
      role: 'user',
      content: `m${String(n)}-` + 'x'.repeat(80),
    }))
    const source: CaptureBatch = {
      session_key: 's',
      agent: 'a',
      channel: 'c',
      title: 't',
      finalize: true,
      messages,
    }
    const two: CaptureBatch = { ...source, messages: messages.slice(0, 2) }
    delete two.finalize
    const limit = byteLength(two)
    expect(byteLength({ ...two, messages: messages.slice(0, 3) })).toBeGreaterThan(limit)
    const bodies: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      bodies.push(String(init?.body))
      const parsed = JSON.parse(String(init?.body)) as CaptureBatch
      return Response.json(okResult(parsed.messages.length, parsed.messages.length === 1 ? 1 : 0))
    })
    const { writer } = await setup(fetch, { maxChunkBytes: limit })
    const saved = await writer.write(source)
    expect(bodies.length).toBeGreaterThan(1)
    expect(byteLength(JSON.parse(bodies[0] ?? '{}'))).toBe(limit)
    for (const body of bodies) expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(limit)
    const parsed = bodies.map((body) => JSON.parse(body) as CaptureBatch)
    expect(parsed.slice(0, -1).every((chunk) => chunk.finalize === undefined)).toBe(true)
    expect(parsed.at(-1)?.finalize).toBe(true)
    expect(parsed.flatMap((chunk) => chunk.messages).map((message) => message.event_id)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
    ])
    expect(parsed[0]).toMatchObject({ session_key: 's', agent: 'a', channel: 'c', title: 't' })
    const inserted = parsed.reduce((sum, chunk) => sum + chunk.messages.length, 0)
    const skipped = parsed.filter((chunk) => chunk.messages.length === 1).length
    expect(saved).toEqual({ ok: true, conversation_id: 'c', inserted, skipped })
  })

  it('sends an empty finalize batch as one chunk', async () => {
    const empty: CaptureBatch = { ...batch, messages: [], finalize: true }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(okResult(0)))
    const { writer } = await setup(fetch)
    expect(await writer.write(empty)).toEqual(okResult(0))
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(empty)
  })

  it('spools some chunks and fails the write when a later chunk cannot spool', async () => {
    const messages: CaptureMessage[] = [1, 2, 3].map((n) => ({
      event_id: `e${String(n)}`,
      role: 'user',
      content: 'x'.repeat(40),
    }))
    const source: CaptureBatch = { session_key: 's', agent: 'a', finalize: true, messages }
    const one = byteLength({ ...source, finalize: undefined, messages: messages.slice(0, 1) })
    const fetch = vi.fn<typeof globalThis.fetch>()
    fetch.mockResolvedValueOnce(Response.json(okResult(1)))
    fetch.mockRejectedValueOnce(new Error('offline'))
    fetch.mockRejectedValue(new Error('offline'))
    const { spoolDir: parent } = await setup(fetch)
    const spoolDir = join(parent, 'not-a-directory')
    await writeFile(spoolDir, 'blocked')
    const log = vi.fn()
    const writer = createCaptureWriter({
      denUrl: 'https://localhost:5174',
      fetch,
      spoolDir,
      log,
      now: () => new Date(1000),
      maxChunkBytes: one,
    })
    const failed = await writer.write(source)
    expect(failed).toEqual({
      spooled: false,
      error: expect.stringContaining('capture spool failed; batch was not saved:'),
    })
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(await readFile(spoolDir, 'utf8')).toBe('blocked')
  })

  it('returns every spooled chunk when delivery fails and none fail to spool', async () => {
    const messages: CaptureMessage[] = [1, 2].map((n) => ({
      event_id: `e${String(n)}`,
      role: 'user',
      content: 'x'.repeat(40),
    }))
    const source: CaptureBatch = { session_key: 's', agent: 'a', messages }
    const one = byteLength({ ...source, messages: messages.slice(0, 1) })
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'))
    const log = vi.fn()
    const { writer, spoolDir } = await setup(fetch, { maxChunkBytes: one, log })
    const saved = await writer.write(source)
    expect(saved).toMatchObject({ spooled: true })
    if (!('spooled' in saved) || !saved.spooled) throw new Error('expected spool')
    expect(saved.files).toHaveLength(2)
    expect(saved.file).toBe(saved.files[0])
    expect(saved.files.map((file) => file.endsWith('.json'))).toEqual([true, true])
    const names = (await readdir(spoolDir)).filter((name) => name.endsWith('.json')).sort()
    expect(names).toHaveLength(2)
    const ordered = await Promise.all(
      names.map(
        async (name) => JSON.parse(await readFile(join(spoolDir, name), 'utf8')) as CaptureBatch,
      ),
    )
    expect(ordered.map((chunk) => chunk.messages[0]?.event_id)).toEqual(['e1', 'e2'])
    expect(log).toHaveBeenCalledWith('Error: offline')
  })

  it('replays chunked spool files in write order', async () => {
    const messages: CaptureMessage[] = [1, 2, 3].map((n) => ({
      event_id: `e${String(n)}`,
      role: 'user',
      content: 'x'.repeat(30),
    }))
    const source: CaptureBatch = { session_key: 's', agent: 'a', finalize: true, messages }
    // Budget fits one message plus finalize, so the last chunk is deliverable
    // and the three messages still travel as separate chunks.
    const one = byteLength({
      session_key: 's',
      agent: 'a',
      finalize: true,
      messages: messages.slice(0, 1),
    })
    const offline = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline'))
    const { spoolDir } = await setup(offline, { maxChunkBytes: one })
    const writer = createCaptureWriter({
      denUrl: 'https://localhost:5174',
      fetch: offline,
      spoolDir,
      now: () => new Date(5000),
      maxChunkBytes: one,
    })
    const spooled = await writer.write(source)
    expect(spooled).toMatchObject({ spooled: true })
    const seen: string[] = []
    const online = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const parsed = JSON.parse(String(init?.body)) as CaptureBatch
      seen.push(parsed.messages.map((message) => message.event_id).join(','))
      return Response.json(okResult(parsed.messages.length))
    })
    const replayed = createCaptureWriter({
      denUrl: 'https://localhost:5174',
      fetch: online,
      spoolDir,
      now: () => new Date(9000),
    })
    const report = await replayed.replay()
    expect(report.dead).toBe(0)
    expect(report.remaining).toBe(0)
    expect(seen[0]).toBe('e1')
    expect(seen.at(-1)).toContain('e3')
    expect(seen.join('|').indexOf('e1')).toBeLessThan(seen.join('|').indexOf('e2'))
    expect(seen.join('|').indexOf('e2')).toBeLessThan(seen.join('|').indexOf('e3'))
    const last = JSON.parse(String(online.mock.calls.at(-1)?.[1]?.body)) as CaptureBatch
    expect(last.finalize).toBe(true)
  })

  it('elides tool_args when one message exceeds the chunk budget', async () => {
    const toolArgs = { blob: 'y'.repeat(4000) }
    const serialized = JSON.stringify(toolArgs)
    const bytes = Buffer.byteLength(serialized, 'utf8')
    const message: CaptureMessage = {
      event_id: 'big',
      role: 'user',
      content: 'hi',
      tool_args: toolArgs,
      metadata: { source: 'codex' },
    }
    const source: CaptureBatch = { session_key: 's', agent: 'a', messages: [message] }
    expect(byteLength(source)).toBeGreaterThan(500)
    const log = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(okResult(1)))
    const { writer } = await setup(fetch, { maxChunkBytes: 500, log })
    await writer.write(source)
    const posted = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as CaptureBatch
    expect(posted.messages).toEqual([
      {
        event_id: 'big',
        role: 'user',
        content: 'hi',
        tool_args: { _elided: true, bytes },
        metadata: { source: 'codex', full_tool_args_length: bytes },
      },
    ])
    expect(byteLength(posted)).toBeLessThanOrEqual(500)
    expect(log).toHaveBeenCalledWith(`elided tool_args for event big (${String(bytes)} bytes)`)
  })

  it('caps content and tool_result like the den, including a split surrogate', async () => {
    const emoji = `${'z'.repeat(15999)}😀`
    const source: CaptureBatch = {
      session_key: 's',
      agent: 'a',
      messages: [
        {
          event_id: 'cap',
          role: 'tool',
          content: 'x'.repeat(16001),
          tool_name: 'exec',
          tool_result: 'y'.repeat(16002),
          metadata: { source: 'codex' },
        },
        { event_id: 'pair', role: 'user', content: emoji },
      ],
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(okResult(2)))
    const { writer } = await setup(fetch)
    await writer.write(source)
    const posted = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as CaptureBatch
    expect(posted.messages[0]).toMatchObject({
      content: 'x'.repeat(16000),
      tool_result: 'y'.repeat(16000),
      metadata: {
        source: 'codex',
        full_content_length: 16001,
        full_tool_result_length: 16002,
        truncated: true,
      },
    })
    expect(posted.messages[1]).toMatchObject({
      content: 'z'.repeat(15999),
      metadata: { full_content_length: 16001, truncated: true },
    })
  })

  it('dead-letters a pre-existing oversized spool file once', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 413 }))
    const log = vi.fn()
    const { writer, spoolDir } = await setup(fetch, { log })
    const name = '1-oversized.json'
    const huge: CaptureBatch = {
      ...batch,
      messages: [{ event_id: 'huge', role: 'user', content: 'x'.repeat(2_000_000) }],
    }
    await writeFile(join(spoolDir, name), JSON.stringify(huge))
    expect(await writer.replay()).toEqual({ replayed: 0, dead: 1, remaining: 0 })
    expect(await readdir(join(spoolDir, 'dead'))).toEqual([name])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('413'))
    expect(await writer.replay()).toEqual({ replayed: 0, dead: 0, remaining: 0 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('elides a huge metadata value instead of posting it', async () => {
    const note = 'm'.repeat(1_100_000)
    const source: CaptureBatch = {
      session_key: 's',
      agent: 'a',
      messages: [
        {
          event_id: 'meta',
          role: 'user',
          content: 'hi',
          metadata: {
            source: 'codex',
            session_jsonl_path: '/tmp/session.jsonl',
            session_jsonl_line: 4,
            note,
          },
        },
      ],
    }
    expect(byteLength(source)).toBeGreaterThan(DEFAULT_LIMIT)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(okResult(1)))
    const { writer, spoolDir } = await setup(fetch)
    await writer.write(source)
    const raw = String(fetch.mock.calls[0]?.[1]?.body)
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(DEFAULT_LIMIT)
    const posted = JSON.parse(raw) as CaptureBatch
    const metadata = posted.messages[0]?.metadata
    expect(metadata).toMatchObject({
      source: 'codex',
      session_jsonl_path: '/tmp/session.jsonl',
      session_jsonl_line: 4,
      metadata_elided: true,
    })
    expect(metadata?.note).toBeUndefined()
    expect(metadata?.full_metadata_bytes).toBeGreaterThan(1_100_000)
    expect(await readdir(spoolDir)).toEqual([])
  })

  it('elides settings when the header alone exceeds the limit', async () => {
    const settings = { blob: 's'.repeat(8_000) }
    const bytes = Buffer.byteLength(JSON.stringify(settings), 'utf8')
    const source: CaptureBatch = {
      session_key: 's',
      agent: 'a',
      settings,
      messages: [],
      finalize: true,
    }
    const limit = 500
    expect(byteLength({ ...source, messages: [] })).toBeGreaterThan(limit)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(okResult(0)))
    const { writer } = await setup(fetch, { maxChunkBytes: limit })
    await writer.write(source)
    const raw = String(fetch.mock.calls[0]?.[1]?.body)
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(limit)
    expect(JSON.parse(raw)).toMatchObject({
      settings: { _elided: true, bytes },
      messages: [],
      finalize: true,
    })
  })

  it('refuses a singleton whose finalize overhead still exceeds the limit', async () => {
    const messages: CaptureMessage[] = [1, 2].map((n) => ({
      event_id: `e${String(n)}`,
      role: 'user',
      content: 'x'.repeat(40),
    }))
    const source: CaptureBatch = { session_key: 's', agent: 'a', finalize: true, messages }
    const one = byteLength({ session_key: 's', agent: 'a', messages: messages.slice(0, 1) })
    expect(byteLength({ ...source, messages: messages.slice(1) })).toBeGreaterThan(one)
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(okResult(1)))
    const log = vi.fn()
    const { writer, spoolDir } = await setup(fetch, { maxChunkBytes: one, log })
    const failed = await writer.write(source)
    expect(failed).toEqual({ spooled: false, error: 'chunk exceeds maxChunkBytes after elision' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).messages[0].event_id).toBe('e1')
    expect(log).toHaveBeenCalledWith('chunk exceeds maxChunkBytes after elision')
    expect(await readdir(spoolDir)).toEqual([])
  })

  it('does not spool a header that still exceeds the limit after settings elision', async () => {
    const source: CaptureBatch = {
      session_key: 's',
      agent: 'a',
      title: 't'.repeat(5_000),
      settings: { blob: 's'.repeat(5_000) },
      messages: [{ event_id: 'e', role: 'user', content: 'hi' }],
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(okResult(1)))
    const log = vi.fn()
    const { writer, spoolDir } = await setup(fetch, { maxChunkBytes: 200, log })
    const failed = await writer.write(source)
    expect(failed).toEqual({ spooled: false, error: 'chunk exceeds maxChunkBytes after elision' })
    expect(fetch).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('chunk exceeds maxChunkBytes after elision')
    expect(await readdir(spoolDir)).toEqual([])
  })

  it('leaves bytes unchanged when redaction is unset (opt-in pin)', async () => {
    const secretBatch: CaptureBatch = {
      session_key: 's',
      agent: 'a',
      messages: [
        {
          event_id: 'e',
          role: 'user',
          content: 'token sk-abcdefghijklmnopqrstuvwxyz stays',
        },
      ],
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(result))
    const { writer } = await setup(fetch)
    await writer.write(secretBatch)
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(secretBatch))
  })

  it('redacts before post when enabled and logs a count only', async () => {
    const secretBatch: CaptureBatch = {
      session_key: 's',
      agent: 'a',
      messages: [
        {
          event_id: 'e',
          role: 'user',
          content: 'token sk-abcdefghijklmnopqrstuvwxyz',
        },
      ],
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(result))
    const log = vi.fn()
    const { writer } = await setup(fetch, { log, redaction: { enabled: true } })
    await writer.write(secretBatch)
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as CaptureBatch
    expect(body.messages[0]?.content).toContain('[REDACTED:sk_token]')
    expect(body.messages[0]?.content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^redacted \d+ spans$/))
    expect(log.mock.calls.flat().join('\n')).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
  })

  it('explicit enabled:false wins over the env enable', async () => {
    process.env[REDACTION_ENV] = '1'
    const secretBatch: CaptureBatch = {
      session_key: 's',
      agent: 'a',
      messages: [
        {
          event_id: 'e',
          role: 'user',
          content: 'token sk-abcdefghijklmnopqrstuvwxyz stays',
        },
      ],
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(result))
    const { writer } = await setup(fetch, { redaction: { enabled: false } })
    await writer.write(secretBatch)
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(secretBatch))
  })
})
