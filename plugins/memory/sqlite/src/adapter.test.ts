/**
 * SqliteMemory contract tests — every Memory method phase 1 implements,
 * plus FTS and opt-in path helpers. Uses an on-disk temp file (WAL) and
 * an in-memory store where a file is unnecessary.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteMemory, buildFtsMatchQuery, resolveSqlitePath } from './adapter.ts'

describe('resolveSqlitePath / buildFtsMatchQuery', () => {
  it('keeps :memory: and expands a leading ~', () => {
    expect(resolveSqlitePath(':memory:')).toBe(':memory:')
    const home = resolveSqlitePath('~/memory.sqlite')
    expect(home.endsWith('/memory.sqlite')).toBe(true)
    expect(home.includes('~')).toBe(false)
  })

  it('builds a safe FTS MATCH query and rejects empty input', () => {
    expect(buildFtsMatchQuery('hello world')).toBe('"hello" AND "world"')
    expect(buildFtsMatchQuery('  ')).toBeNull()
    expect(buildFtsMatchQuery('a^b (c)')).toBe('"ab" AND "c"')
  })
})

describe('SqliteMemory Memory contract', () => {
  const dirs: string[] = []
  const open: SqliteMemory[] = []

  function fileStore(): SqliteMemory {
    const dir = mkdtempSync(join(tmpdir(), 'ros-mem-'))
    dirs.push(dir)
    const memory = new SqliteMemory({ path: join(dir, 'memory.sqlite') })
    open.push(memory)
    return memory
  }

  function memStore(): SqliteMemory {
    const memory = new SqliteMemory({ path: ':memory:' })
    open.push(memory)
    return memory
  }

  afterEach(() => {
    for (const m of open) m.close()
    open.length = 0
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('is healthy after open and reports WAL file path', async () => {
    const memory = fileStore()
    expect(await memory.isHealthy()).toBe(true)
    expect(memory.getPath().endsWith('memory.sqlite')).toBe(true)
  })

  it('append → getSessionHistory round-trips in chronological order', async () => {
    const memory = memStore()
    const session = 'sess-history-1'
    await memory.append({
      sessionId: session,
      agent: 'grok',
      channel: 'test',
      role: 'user',
      content: 'first',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    await memory.append({
      sessionId: session,
      agent: 'grok',
      channel: 'test',
      role: 'assistant',
      content: 'second',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    })

    const history = await memory.getSessionHistory(session)
    expect(history.map((m) => m.content)).toEqual(['first', 'second'])
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('search finds appended content via FTS5 and respects agent filter', async () => {
    const memory = memStore()
    await memory.append({
      sessionId: 's1',
      agent: 'grok',
      channel: 'test',
      role: 'user',
      content: 'the flurbnozzle protocol lives here',
    })
    await memory.append({
      sessionId: 's2',
      agent: 'opus',
      channel: 'test',
      role: 'user',
      content: 'unrelated gardening notes',
    })

    const hits = await memory.search('flurbnozzle protocol', { limit: 5 })
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0].content).toContain('flurbnozzle')

    const grokOnly = await memory.search('flurbnozzle', { agent: 'grok' })
    expect(grokOnly.every((h) => h.agent === 'grok')).toBe(true)

    const summaries = await memory.search('flurbnozzle', { scope: 'summaries' })
    expect(summaries).toEqual([])
  })

  it('getContextForTurn excludes heartbeat sessions from Recent', async () => {
    const memory = memStore()
    const agent = 'ctx-agent'
    await memory.append({
      sessionId: `heartbeat:${agent}`,
      agent,
      channel: 'heartbeat',
      role: 'assistant',
      content: 'HEARTBEAT_OK',
    })
    await memory.append({
      sessionId: `chat-${agent}`,
      agent,
      channel: 'test',
      role: 'user',
      content: 'real user message about widgets',
    })

    const ctx = await memory.getContextForTurn('widgets', agent)
    const recentSection = ctx.split('## Relevant Context')[0]
    expect(recentSection).toContain('## Recent')
    expect(recentSection).toContain('real user message about widgets')
    expect(recentSection).not.toContain('HEARTBEAT_OK')
  })

  it('save/loadSessionSettings round-trips JSON', async () => {
    const memory = memStore()
    const session = 'settings-sess'
    await memory.append({
      sessionId: session,
      agent: 'grok',
      channel: 'test',
      role: 'user',
      content: 'hi',
    })
    await memory.saveSessionSettings(session, { thinking: 'high', visible: true })
    expect(await memory.loadSessionSettings(session)).toEqual({
      thinking: 'high',
      visible: true,
    })
    expect(await memory.loadSessionSettings('missing')).toBeNull()
  })

  it('getTaskHistory unions task_id and legacy task:<id> session keys', async () => {
    const memory = memStore()
    const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

    await memory.append({
      sessionId: `task:${taskId}`,
      agent: 'grok',
      channel: 'task',
      role: 'user',
      content: 'legacy leg',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    })

    await memory.append({
      sessionId: 'harness-spawn-1',
      agent: 'grok',
      channel: 'harness',
      role: 'assistant',
      content: 'spawn leg',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    })
    memory.associateTask('harness-spawn-1', 'grok', taskId)

    const history = await memory.getTaskHistory(taskId)
    expect(history.map((m) => m.content)).toEqual(['legacy leg', 'spawn leg'])
  })

  it('reopens a WAL file and still finds prior rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ros-mem-reopen-'))
    dirs.push(dir)
    const path = join(dir, 'memory.sqlite')

    const first = new SqliteMemory({ path })
    open.push(first)
    await first.append({
      sessionId: 'persist',
      agent: 'grok',
      channel: 'test',
      role: 'user',
      content: 'persisted flurbnozzle row',
    })
    first.close()
    open.pop()

    const second = new SqliteMemory({ path })
    open.push(second)
    const history = await second.getSessionHistory('persist')
    expect(history[0]?.content).toBe('persisted flurbnozzle row')
    const hits = await second.search('flurbnozzle')
    expect(hits.length).toBe(1)
  })

  it('enqueues embed work on append without requiring an embedder', async () => {
    const memory = memStore()
    const id = await memory.append({
      sessionId: 'embed-q',
      agent: 'grok',
      channel: 'test',
      role: 'user',
      content: 'queue me',
    })
    expect(memory.hasEmbedQueueEntryForTest(id)).toBe(true)
  })
})
