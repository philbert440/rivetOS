/**
 * Export and import in the shared gzip NDJSON v1 format: a round trip
 * between two SQLite stores, the shape Postgres reads, and the merge rules.
 */

import { PassThrough, Readable } from 'node:stream'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXPORT_TABLES } from '@rivetos/memory-core'
import { applyPatch } from '@rivetos/wiki-core'
import { SqliteMemory } from './adapter.js'
import { exportSqliteMemory, importSqliteMemory } from './portability.js'

const noWait = async (): Promise<void> => {}
const SUMMARY =
  'The team decided to deploy the acmeapp service blue-green from the release branch, with a health check ' +
  'before the traffic switch and a documented rollback. Notes were written for the next release.'

async function dump(memory: SqliteMemory, since?: string): Promise<Buffer> {
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', (c: Buffer) => chunks.push(c))
  await exportSqliteMemory(memory.database(), out, {
    exportedAt: '2026-10-04T00:00:00.000Z',
    source: { kind: 'local', id: 'testhost' },
    ...(since ? { since } : {}),
  })
  return Buffer.concat(chunks)
}

function lines(gz: Buffer): Array<Record<string, unknown>> {
  return gunzipSync(gz)
    .toString('utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

async function seeded(): Promise<SqliteMemory> {
  const fetch = vi.fn(async () =>
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: SUMMARY } }] }),
  ) as unknown as typeof globalThis.fetch
  const memory = new SqliteMemory({
    path: ':memory:',
    workers: false,
    log: () => {},
    userId: 'alice',
    projectRule: null,
    wiki: { dir: '/nonexistent-wiki-dir' },
    compactor: { endpoint: 'https://llm.test/v1', model: 'm', fetch, sleep: noWait },
  })
  await memory.saveSessionSettings('s1', {})
  for (let i = 0; i < 10; i += 1) {
    await memory.append({
      sessionId: 's1',
      agent: 'rivet',
      channel: 'cli',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message number ${String(i)} about deploying the acmeapp service`,
      ...(i === 1 ? { toolName: 'Bash', toolArgs: { command: 'make deploy' }, metadata: { source: 'hook' } } : {}),
    })
  }
  await memory.saveSessionSettings('s1', { cwd: '/work/acmeapp' })
  await memory.runJobs()
  memory.wiki()?.index.upsertTopic(
    applyPatch(undefined, {
      action: 'create',
      slug: 'acmeapp-deploys',
      title: 'Acmeapp deploys',
      addAliases: ['acmeapp-rollout'],
      addTags: ['deploy'],
      currentState: 'Deployed blue-green.',
      verifiedAt: '2026-10-01T00:00:00.000Z',
    }),
  )
  memory.wiki()?.index.setRedirect('acme-releases', 'acmeapp-deploys')
  return memory
}

describe('SQLite memory export / import', () => {
  const open: SqliteMemory[] = []
  afterEach(() => {
    for (const m of open.splice(0)) m.close()
  })

  it('writes the shared format: header, tables in order, JSON as values, no vectors', async () => {
    const source = await seeded()
    open.push(source)
    const rows = lines(await dump(source))
    expect(rows[0]).toEqual({
      type: 'rivet-memory-export',
      version: 1,
      exported_at: '2026-10-04T00:00:00.000Z',
      source: { kind: 'local', id: 'testhost' },
      tables: [...EXPORT_TABLES],
    })
    const tables = rows.slice(1).map((r) => r.t as string)
    expect(tables).toEqual([...tables].sort((a, b) => EXPORT_TABLES.indexOf(a as never) - EXPORT_TABLES.indexOf(b as never)))
    expect(new Set(tables)).toEqual(
      new Set(['ros_conversations', 'ros_messages', 'ros_summaries', 'ros_summary_sources', 'ros_wiki_topics', 'ros_wiki_redirects']),
    )
    const conversation = rows.find((r) => r.t === 'ros_conversations')?.r as Record<string, unknown>
    expect(conversation).toMatchObject({ session_key: 's1', active: true, settings: { cwd: '/work/acmeapp' }, owner_user_id: 'alice' })
    const tool = rows.map((r) => r.r as Record<string, unknown> | undefined).find((r) => r?.tool_name === 'Bash')
    expect(tool).toMatchObject({ tool_args: { command: 'make deploy' }, metadata: { source: 'hook' }, owner_user_id: 'alice' })
    const topic = rows.find((r) => r.t === 'ros_wiki_topics')?.r as Record<string, unknown>
    expect(topic).toMatchObject({ slug: 'acmeapp-deploys', aliases: ['acmeapp-rollout'], tags: ['deploy'] })
    for (const r of rows.slice(1)) {
      expect(Object.keys(r.r as object)).not.toContain('embedding')
      expect(Object.keys(r.r as object)).not.toContain('embed_status')
    }
  })

  it('round-trips into an empty store, and a second import changes nothing', async () => {
    const source = await seeded()
    const target = new SqliteMemory({ path: ':memory:', log: () => {}, wiki: { dir: '/nonexistent-wiki-dir' } })
    open.push(source, target)
    const gz = await dump(source)

    const first = await importSqliteMemory(target.database(), Readable.from([gz]))
    expect(first.inserted).toMatchObject({
      ros_conversations: 1,
      ros_messages: 10,
      ros_summaries: 1,
      ros_summary_sources: 10,
      ros_wiki_topics: 1,
      ros_wiki_redirects: 1,
    })
    // Before anything is searched (a search bumps access counts): the two
    // stores export the same rows.
    expect(lines(await dump(target)).slice(1)).toEqual(lines(gz).slice(1))
    expect(await target.getSessionHistory('s1')).toHaveLength(10)
    expect(await target.loadSessionSettings('s1')).toEqual({ cwd: '/work/acmeapp' })
    expect((await target.search('deploying', { scope: 'messages' })).length).toBeGreaterThan(0)
    expect((await target.search('blue-green', { scope: 'summaries' }))[0]).toMatchObject({ role: 'leaf' })
    expect((await target.wiki()?.index.getTopic('acme-releases'))?.slug).toBe('acmeapp-deploys')
    expect((await target.wiki()?.index.searchTopics('blue-green'))?.[0].slug).toBe('acmeapp-deploys')

    const again = await importSqliteMemory(target.database(), Readable.from([gz]))
    expect(Object.values(again.inserted).every((n) => n === 0)).toBe(true)
    expect(await target.getSessionHistory('s1')).toHaveLength(10)
  })

  it('merges a conversation that already exists under another id, and a dry run writes nothing', async () => {
    const source = await seeded()
    const target = new SqliteMemory({ path: ':memory:', log: () => {} })
    open.push(source, target)
    // The same session was already started on the target, under its own conversation id.
    await target.append({ sessionId: 's1', agent: 'rivet', channel: 'cli', role: 'user', content: 'already here' })
    const gz = await dump(source)

    const dry = await importSqliteMemory(target.database(), Readable.from([gz]), { dryRun: true })
    expect(dry.inserted.ros_messages).toBe(10)
    expect(await target.getSessionHistory('s1')).toHaveLength(1)

    const result = await importSqliteMemory(target.database(), Readable.from([gz]))
    expect(result.merged.ros_conversations).toBe(1)
    expect(result.inserted.ros_conversations).toBe(0)
    expect(result.inserted.ros_messages).toBe(10)
    // One conversation holds both the existing message and the imported ones.
    expect(await target.getSessionHistory('s1')).toHaveLength(11)
    expect(target.countForTest('ros_conversations')).toBe(1)
  })

  it('--since keeps the rows written after it and the conversation they belong to', async () => {
    const source = await seeded()
    open.push(source)
    const none = lines(await dump(source, '2999-01-01T00:00:00Z'))
    expect(none).toHaveLength(1)
    const all = lines(await dump(source, '2000-01-01T00:00:00Z'))
    expect(all.filter((r) => r.t === 'ros_messages')).toHaveLength(10)
    expect(all.filter((r) => r.t === 'ros_conversations')).toHaveLength(1)
  })

  it('refuses a file that is not an export, and leaves the store untouched when a row is bad', async () => {
    const target = new SqliteMemory({ path: ':memory:', log: () => {} })
    open.push(target)
    const db = target.database()
    const gz = (text: string): Readable => Readable.from([gzipSync(text)])
    await expect(importSqliteMemory(db, gz('{"type":"something-else","version":1}\n'))).rejects.toThrow(/not a rivet memory export/)
    await expect(importSqliteMemory(db, gz('{"type":"rivet-memory-export","version":2}\n'))).rejects.toThrow(/unsupported export version/)
    const header = '{"type":"rivet-memory-export","version":1}\n'
    const conv = JSON.stringify({ t: 'ros_conversations', r: { id: 'c1', session_key: 's', agent: 'a', created_at: 'x', updated_at: 'x' } })
    await expect(importSqliteMemory(db, gz(`${header}${conv}\n{"t":"ros_secrets","r":{}}\n`))).rejects.toThrow(/unknown table/)
    expect(target.countForTest('ros_conversations')).toBe(0)
    // A message whose conversation is nowhere is skipped, not inserted loose.
    const orphan = JSON.stringify({ t: 'ros_messages', r: { id: 'm1', conversation_id: 'missing', agent: 'a', channel: 'c', role: 'user', content: 'x', created_at: 'x' } })
    const result = await importSqliteMemory(db, gz(`${header}${orphan}\n`))
    expect(result.skipped.ros_messages).toBe(1)
    expect(target.countForTest('ros_messages')).toBe(0)
  })
})
