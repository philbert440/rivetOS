import { describe, expect, it } from 'vitest'
import {
  LIST_CONVERSATIONS_SQL,
  READONLY_POOL_OPTIONS,
  ROWS_BY_CONVERSATION_SQL,
  assertReadOnlySql,
  fetchGrokbotRows,
  loadRivetosPgUrlFromEnv,
  wrapReadOnlyClient,
} from '../src/pg-readonly.js'
import { FROM_ROWS_LIMITS } from '../src/reclean.js'

describe('read-only rows source', () => {
  it('uses a single-connection read-only pool', () => {
    expect(READONLY_POOL_OPTIONS.max).toBe(1)
    expect(READONLY_POOL_OPTIONS.options).toContain('default_transaction_read_only=on')
  })

  it('refuses INSERT/UPDATE/DELETE', () => {
    expect(() => assertReadOnlySql('SELECT 1')).not.toThrow()
    expect(() => assertReadOnlySql('BEGIN TRANSACTION READ ONLY')).not.toThrow()
    expect(() => assertReadOnlySql('ROLLBACK')).not.toThrow()
    expect(() => assertReadOnlySql(LIST_CONVERSATIONS_SQL)).not.toThrow()
    expect(() => assertReadOnlySql(ROWS_BY_CONVERSATION_SQL)).not.toThrow()
    expect(() => assertReadOnlySql('INSERT INTO ros_messages (id) VALUES (1)')).toThrow(
      /refusing write/,
    )
    expect(() => assertReadOnlySql('UPDATE ros_messages SET content = $1')).toThrow(
      /refusing write/,
    )
    expect(() => assertReadOnlySql('DELETE FROM ros_messages WHERE id = $1')).toThrow(
      /refusing write/,
    )
  })

  it('does not read a URL from argv-shaped env keys', () => {
    expect(
      loadRivetosPgUrlFromEnv({
        RIVETOS_ENV_FILE: '/tmp/does-not-exist-rivetos-pg.env',
        PG_URL: 'postgres://should-not-use',
      } as unknown as NodeJS.ProcessEnv),
    ).toBeUndefined()
    expect(
      loadRivetosPgUrlFromEnv({
        RIVETOS_PG_URL: 'postgres://from-env/rivetos',
      } as NodeJS.ProcessEnv),
    ).toBe('postgres://from-env/rivetos')
  })

  it('runs SELECTs inside BEGIN TRANSACTION READ ONLY and ROLLBACK, never writes', async () => {
    const sqls: string[] = []
    const client = wrapReadOnlyClient({
      query: async (sql: string) => {
        sqls.push(sql)
        if (/BEGIN/i.test(sql) || /ROLLBACK/i.test(sql)) return { rows: [] }
        if (/ros_conversations/i.test(sql)) {
          return {
            rows: [
              {
                conversation_id: '11111111-1111-4111-8111-111111111111',
                session_key: 'grokbot-rivet-grokbot',
                agent: 'rivet-grokbot',
                n: 2,
              },
              {
                conversation_id: '22222222-2222-4222-8222-222222222222',
                session_key: 'grokbot-rivet-grokbot',
                agent: 'rivet-grokbot',
                n: 1,
              },
            ],
          }
        }
        return {
          rows: [{ role: 'user', content: 'x', ordinal: 0 }],
        }
      },
    })
    const groups = await fetchGrokbotRows(client, 'grokbot-rivet-grokbot', 'rivet-grokbot')
    expect(sqls[0]).toMatch(/BEGIN TRANSACTION READ ONLY/i)
    expect(sqls.at(-1)).toMatch(/ROLLBACK/i)
    expect(sqls.some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false)
    expect(groups).toHaveLength(2)
    expect(groups[0].conversation.conversation_id).not.toBe(groups[1].conversation.conversation_id)
    expect(FROM_ROWS_LIMITS).toMatch(/cannot restore tool results/)
  })
})
