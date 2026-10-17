import { describe, expect, it } from 'vitest'
import { buildMemoryDump, MEMORY_DUMP_TABLES, pgDumpEquivalentArgs } from './pglite-dump.js'

/** A query stub: two tables exist, the rest are absent from this schema. */
function stubQuery() {
  const seen: string[] = []
  const columns: Record<string, string[]> = {
    ros_conversations: ['id', 'session_key', 'title'],
    ros_messages: ['id', 'conversation_id', 'content', 'embedding'],
  }
  const data: Record<string, string> = {
    ros_conversations: '11111111-1111-1111-1111-111111111111\ts1\tTab\\there\n',
    ros_messages: 'aaaa\t1111\thello\\nworld\t[0.25,0.5]\nbbbb\t1111\t\\N\t\\N\n',
  }
  const query = (sql: string) => {
    seen.push(sql)
    const table = /table_name = '(\w+)'/.exec(sql)?.[1]
    if (table) {
      return Promise.resolve({ rows: (columns[table] ?? []).map((c) => ({ column_name: c })) })
    }
    const copy = /^COPY public\.(\w+) /.exec(sql)?.[1]
    if (copy) return Promise.resolve({ rows: [], blob: new Blob([data[copy] ?? '']) })
    return Promise.resolve({ rows: [] })
  }
  return { query, seen }
}

describe('buildMemoryDump', () => {
  it('writes plain pg_dump COPY blocks the RivetHub importer accepts', async () => {
    const { query } = stubQuery()
    const { text, rows } = await buildMemoryDump(query)
    expect(rows).toEqual({ ros_conversations: 1, ros_messages: 2 })
    expect(text).toContain(
      'COPY public.ros_conversations (id, session_key, title) FROM stdin;\n11111111-1111-1111-1111-111111111111\ts1\tTab\\there\n\\.\n',
    )
    expect(text).toContain(
      'COPY public.ros_messages (id, conversation_id, content, embedding) FROM stdin;\n',
    )
    expect(text).toContain("SELECT pg_catalog.set_config('search_path', '', false);")
    expect(text.trimEnd().endsWith('-- PostgreSQL database dump complete\n--')).toBe(true)
    // Every non-COPY, non-comment line is one of pg_dump's preamble statements.
    let inCopy = false
    for (const line of text.split('\n')) {
      if (inCopy) {
        if (line === '\\.') inCopy = false
        continue
      }
      if (line.startsWith('COPY ')) {
        inCopy = true
        continue
      }
      if (line === '' || line.startsWith('--')) continue
      expect(line).toMatch(/^(SET [a-z_]+ = .+;|SELECT pg_catalog\.set_config\(.*\);)$/)
    }
  })

  it('reads every table from one read-only snapshot in UTC', async () => {
    const { query, seen } = stubQuery()
    await buildMemoryDump(query)
    expect(seen[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(seen).toContain("SET LOCAL TimeZone = 'UTC'")
    expect(seen.at(-1)).toBe('COMMIT')
    expect(seen.filter((q) => q.startsWith('COPY'))).toHaveLength(2)
  })

  it('names the same tables RivetHub asks pg_dump for', () => {
    expect(MEMORY_DUMP_TABLES).toHaveLength(11)
    expect(pgDumpEquivalentArgs()).toContain('--table=public.ros_wiki_redirects')
    expect(pgDumpEquivalentArgs().slice(0, 2)).toEqual(['--data-only', '--format=plain'])
  })
})
