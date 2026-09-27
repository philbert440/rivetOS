import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCaptureWriter } from './writer.js'
import { spoolBatch } from './spool.js'
import type { CaptureBatch } from './types.js'

const batch: CaptureBatch = {
  session_key: 'codex:s',
  agent: 'rivet',
  messages: [{ event_id: 'e', role: 'user', content: 'hello' }],
}
const result = { ok: true, conversation_id: 'c', inserted: 1, skipped: 0 }
const dirs: string[] = []
async function setup(fetch: typeof globalThis.fetch) {
  const spoolDir = await mkdtemp(join(tmpdir(), 'capture-'))
  dirs.push(spoolDir)
  return {
    spoolDir,
    writer: createCaptureWriter({
      denUrl: 'https://localhost:5174/',
      fetch,
      spoolDir,
      now: () => new Date(1000),
    }),
  }
}
afterEach(async () => {
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
      if (!('spooled' in saved)) throw new Error('expected spool')
      expect(saved.file).toMatch(/1000-.*\.json$/)
      expect(await readFile(saved.file, 'utf8')).toBe(JSON.stringify(batch))
      expect((await stat(saved.file)).mode & 0o777).toBe(0o600)
      expect(await readdir(spoolDir)).toHaveLength(1)
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
})
