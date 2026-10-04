/**
 * Per-plugin SqliteMemory tests — every Memory method phase 1 implements,
 * plus FTS, permissions, schema version, and path helpers. Uses an on-disk
 * temp file (WAL) and an in-memory store where a file is unnecessary.
 */

import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SqliteMemory,
  buildFtsMatchQuery,
  ensureSqliteParentDir,
  relevanceFromBm25,
  resolveSqlitePath,
  resolveTaskId,
  restrictSqliteFileModes,
} from './adapter.ts'
import { DatabaseSync } from 'node:sqlite'
import { SCHEMA, SCHEMA_VERSION } from './schema.ts'

describe('resolveSqlitePath / buildFtsMatchQuery / relevanceFromBm25', () => {
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

  it('maps negative bm25 ranks to varying relevance scores', () => {
    // Regression: Math.max(0, negative) collapsed every hit to 1.0.
    expect(relevanceFromBm25(0)).toBe(1)
    expect(relevanceFromBm25(-0.000001)).toBeLessThan(1)
    expect(relevanceFromBm25(-2)).toBeLessThan(relevanceFromBm25(-0.5))
    expect(relevanceFromBm25(-2)).toBe(relevanceFromBm25(2))
  })

  it('resolveTaskId reads task:<uuid> sessions and metadata.taskId', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(resolveTaskId(`task:${id}`)).toBe(id)
    expect(resolveTaskId('harness-spawn-1', { taskId: id })).toBe(id)
    expect(resolveTaskId('plain-session')).toBeNull()
    expect(resolveTaskId('task:not-a-uuid')).toBeNull()
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
    // bm25 ranks are negative; scores must vary and stay in (0,1].
    expect(hits[0].relevanceScore).toBeGreaterThan(0)
    expect(hits[0].relevanceScore).toBeLessThanOrEqual(1)
    expect(hits[0].relevanceScore).not.toBe(1)

    const grokOnly = await memory.search('flurbnozzle', { agent: 'grok' })
    expect(grokOnly.every((h) => h.agent === 'grok')).toBe(true)

    const summaries = await memory.search('flurbnozzle', { scope: 'summaries' })
    expect(summaries).toEqual([])

    // Phase 1: scope 'both' is messages-only (no summary arm yet).
    const both = await memory.search('flurbnozzle', { scope: 'both' })
    expect(both.length).toBeGreaterThanOrEqual(1)
  })

  it('creates the DB directory 0700 and the file (+wal/+shm) 0600', () => {
    // Permissive umask: without explicit chmod, node:sqlite would leave the DB at 0644.
    const prevUmask = process.umask(0o022)
    try {
      const parent = mkdtempSync(join(tmpdir(), 'ros-mem-mode-'))
      dirs.push(parent)
      const dir = join(parent, 'private')
      const path = join(dir, 'memory.sqlite')
      const memory = new SqliteMemory({ path })
      open.push(memory)
      // Force a write so WAL/SHM siblings exist under journal_mode=WAL.
      memory.execForTest(`SELECT 1`)

      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      for (const suffix of ['-wal', '-shm'] as const) {
        const sibling = `${path}${suffix}`
        try {
          expect(statSync(sibling).mode & 0o777).toBe(0o600)
        } catch (err) {
          // Some node:sqlite builds defer -shm until a second connection; WAL is enough.
          if (suffix === '-shm' && (err as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw err
        }
      }
    } finally {
      process.umask(prevUmask)
    }
  })

  it('does not chmod a pre-existing parent directory', () => {
    // Regression: unconditional chmodSync(dirname) would repermission /tmp or $HOME.
    const parent = mkdtempSync(join(tmpdir(), 'ros-mem-preexist-'))
    dirs.push(parent)
    chmodSync(parent, 0o755)
    expect(statSync(parent).mode & 0o777).toBe(0o755)

    const memory = new SqliteMemory({ path: join(parent, 'memory.sqlite') })
    open.push(memory)

    expect(statSync(parent).mode & 0o777).toBe(0o755)
  })

  it('ensureSqliteParentDir chmods only a directory it created', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ros-mem-ensure-'))
    dirs.push(parent)
    chmodSync(parent, 0o755)
    ensureSqliteParentDir(parent)
    expect(statSync(parent).mode & 0o777).toBe(0o755)

    const created = join(parent, 'new-leaf')
    ensureSqliteParentDir(created)
    expect(statSync(created).mode & 0o777).toBe(0o700)
  })

  it('restrictSqliteFileModes does not throw when chmod fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Missing path → chmod ENOENT; without the try/catch this throws and the
    // fail-soft registrar would drop the memory backend entirely.
    expect(() =>
      restrictSqliteFileModes(join(tmpdir(), 'ros-mem-no-such-dir', 'missing.sqlite')),
    ).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not chmod'))
    warn.mockRestore()
  })

  it('stamps SCHEMA_VERSION via PRAGMA user_version', () => {
    const memory = memStore()
    expect(memory.schemaVersionForTest()).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
  })

  it('keeps FTS in sync on delete via triggers (no orphaned FTS rows)', async () => {
    const memory = memStore()
    const id = await memory.append({
      sessionId: 'fts-del',
      agent: 'grok',
      channel: 'test',
      role: 'user',
      content: 'orphan-check flurbnozzle unique-token',
    })
    expect(memory.ftsRowCountForTest(id)).toBe(1)

    // CASCADE-delete the conversation; AFTER DELETE trigger must drop the FTS row
    // (search JOIN would hide orphans — count the FTS table directly).
    memory.execForTest(`DELETE FROM ros_conversations WHERE session_key = ?`, 'fts-del')
    expect(memory.ftsRowCountForTest(id)).toBe(0)

    const id2 = await memory.append({
      sessionId: 'fts-del-2',
      agent: 'grok',
      channel: 'test',
      role: 'user',
      content: 'second unique-token-two',
    })
    expect(memory.ftsRowCountForTest(id2)).toBe(1)
    memory.execForTest(`DELETE FROM ros_messages WHERE id = ?`, id2)
    expect(memory.ftsRowCountForTest(id2)).toBe(0)

    // UPDATE content must refresh the FTS row (not leave stale text).
    const id3 = await memory.append({
      sessionId: 'fts-upd',
      agent: 'grok',
      channel: 'test',
      role: 'user',
      content: 'before-update-token',
    })
    memory.execForTest(
      `UPDATE ros_messages SET content = ? WHERE id = ?`,
      'after-update-token',
      id3,
    )
    expect((await memory.search('before-update-token')).length).toBe(0)
    expect((await memory.search('after-update-token')).length).toBe(1)
    expect(memory.ftsRowCountForTest(id3)).toBe(1)
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
    // Append under task:<uuid> must populate task_id (not only session_key).
    expect(memory.conversationTaskIdForTest(`task:${taskId}`, 'grok')).toBe(taskId)

    await memory.append({
      sessionId: 'harness-spawn-1',
      agent: 'grok',
      channel: 'harness',
      role: 'assistant',
      content: 'spawn leg',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
      metadata: { taskId },
    })
    expect(memory.conversationTaskIdForTest('harness-spawn-1', 'grok')).toBe(taskId)

    const history = await memory.getTaskHistory(taskId)
    expect(history.map((m) => m.content)).toEqual(['legacy leg', 'spawn leg'])
  })

  it('associateTask still stamps task_id after the first append', async () => {
    const memory = memStore()
    const taskId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
    await memory.append({
      sessionId: 'late-assoc',
      agent: 'grok',
      channel: 'harness',
      role: 'user',
      content: 'before assoc',
    })
    expect(memory.conversationTaskIdForTest('late-assoc', 'grok')).toBeNull()
    memory.associateTask('late-assoc', 'grok', taskId)
    expect(memory.conversationTaskIdForTest('late-assoc', 'grok')).toBe(taskId)
    const history = await memory.getTaskHistory(taskId)
    expect(history.map((m) => m.content)).toEqual(['before assoc'])
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

  it('queues no embed work without an embedding endpoint (nothing to pile up)', async () => {
    const memory = memStore()
    const id = await memory.append({
      sessionId: 's1',
      agent: 'rivet',
      channel: 'cli',
      role: 'user',
      content: 'no embedder configured',
    })
    expect(memory.hasEmbedQueueEntryForTest(id)).toBe(false)
    expect(memory.jobs().counts()).toEqual([])
  })
})

describe('schema upgrade v1 → v2 (tag tables)', () => {
  it('adds ros_tags + ros_tag_taxonomy to an existing v1 file, stamps v2, keeps rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ros-mem-v1-'))
    const file = join(dir, 'memory.sqlite')
    try {
      // A v1 database: today's DDL minus everything later versions added
      // (v2 tag tables; v3 job/meta tables and the vector columns), stamped
      // user_version = 1, so the upgrade path really has work to do.
      const v1 = new DatabaseSync(file)
      // ros_messages as it was before v3: no vector columns.
      const v1Schema = SCHEMA.replace(
        /embed_status {6}TEXT,\n(?: {4}--[^\n]*\n)* {4}embedding[^\n]*\n {4}embed_error[^\n]*\n {4}embed_failures[^\n]*\n/,
        'embed_status      TEXT\n',
      )
      expect(v1Schema).not.toBe(SCHEMA)
      v1.exec(v1Schema)
      v1.exec('DROP TABLE ros_tags; DROP TABLE ros_tag_taxonomy;')
      v1.exec('DROP TABLE ros_jobs; DROP TABLE ros_meta;')
      // v4 summary tables (their triggers go with them).
      v1.exec('DROP TABLE ros_summaries_fts; DROP TABLE ros_summary_sources; DROP TABLE ros_summaries;')
      v1.exec('PRAGMA user_version = 1')
      v1.prepare(
        `INSERT INTO ros_conversations (id, session_key, agent, created_at, updated_at)
         VALUES ('c-v1', 'claude-code:v1', 'rivet', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
      ).run()
      v1.close()

      const memory = new SqliteMemory({ path: file })
      expect(memory.schemaVersionForTest()).toBe(SCHEMA_VERSION)
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2)
      await memory.close()

      const after = new DatabaseSync(file)
      const tables = (
        after
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ros_tag%'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
      expect(tables.sort()).toEqual(['ros_tag_taxonomy', 'ros_tags'])
      const later = (
        after
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ros_jobs', 'ros_meta')`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
      expect(later.sort()).toEqual(['ros_jobs', 'ros_meta'])
      expect(
        after
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ros_messages_unembedded'`)
          .get(),
      ).toBeDefined()
      const summaryTables = (
        after
          .prepare(
            `SELECT name FROM sqlite_master WHERE name IN ('ros_summaries', 'ros_summary_sources', 'ros_summaries_fts')`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
      expect(summaryTables.sort()).toEqual(['ros_summaries', 'ros_summaries_fts', 'ros_summary_sources'])
      const columns = (after.prepare('PRAGMA table_info(ros_messages)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      )
      expect(columns).toEqual(expect.arrayContaining(['embedding', 'embed_error', 'embed_failures']))
      const kept = after.prepare(`SELECT session_key FROM ros_conversations WHERE id = 'c-v1'`).get() as
        | { session_key: string }
        | undefined
      expect(kept?.session_key).toBe('claude-code:v1')
      after.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
