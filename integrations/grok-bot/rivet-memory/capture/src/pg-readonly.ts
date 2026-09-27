/**
 * Read-only Postgres access for re-clean. Never accepts a URL on argv.
 * Connection string comes from RIVETOS_PG_URL (env or ~/.rivetos/.env).
 * Every query is issued inside BEGIN TRANSACTION READ ONLY and rolled back.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import pg from 'pg'
import type { StoredRow } from './types.js'

const WRITE_SQL_RE =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|CALL|DO)\b/i

export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
}

export interface GrokbotConversation {
  conversation_id: string
  session_key: string
  agent: string
  n: number
}

export const LIST_CONVERSATIONS_SQL = `
SELECT c.id::text AS conversation_id, c.session_key, c.agent, count(m.id)::int AS n
  FROM ros_conversations c
  JOIN ros_messages m ON m.conversation_id = c.id
 WHERE c.channel = 'grokbot'
   AND c.session_key = $1
   AND ($2::text IS NULL OR c.agent = $2)
 GROUP BY c.id, c.session_key, c.agent
 ORDER BY c.id
`.trim()

export const ROWS_BY_CONVERSATION_SQL = `
SELECT m.role, m.content, m.tool_name, m.tool_args, m.tool_result, m.created_at, m.metadata,
       (m.metadata->>'ordinal')::int AS ordinal, m.conversation_id::text AS conversation_id
  FROM ros_messages m
 WHERE m.conversation_id = $1
 ORDER BY COALESCE((m.metadata->>'ordinal')::int, 0), m.created_at
`.trim()

export function assertReadOnlySql(sql: string): void {
  const stripped = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  if (WRITE_SQL_RE.test(stripped)) {
    throw new Error('pg-readonly: refusing write SQL on a read-only connection')
  }
}

export function loadRivetosPgUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.RIVETOS_PG_URL?.trim()
  if (direct) return direct
  const file = env.RIVETOS_ENV_FILE || resolve(homedir(), '.rivetos/.env')
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^(?:export\s+)?RIVETOS_PG_URL=(.*)$/.exec(line.trim())
      if (!m) continue
      const value = m[1].replace(/^['"]|['"]$/g, '').trim()
      if (value) return value
    }
  } catch {
    /* optional */
  }
  return undefined
}

export function wrapReadOnlyClient(client: Queryable): Queryable {
  return {
    query: async (sql: string, params?: unknown[]) => {
      assertReadOnlySql(sql)
      return client.query(sql, params)
    },
  }
}

export async function withReadOnlyTransaction<T>(
  client: Queryable,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> {
  const guarded = wrapReadOnlyClient(client)
  await guarded.query('BEGIN TRANSACTION READ ONLY')
  try {
    return await fn(guarded)
  } finally {
    await guarded.query('ROLLBACK')
  }
}

export async function listGrokbotConversations(
  client: Queryable,
  sessionKey: string,
  agent?: string,
): Promise<GrokbotConversation[]> {
  const result = await client.query(LIST_CONVERSATIONS_SQL, [sessionKey, agent ?? null])
  return result.rows as GrokbotConversation[]
}

export async function fetchRowsForConversation(
  client: Queryable,
  conversationId: string,
): Promise<StoredRow[]> {
  const result = await client.query(ROWS_BY_CONVERSATION_SQL, [conversationId])
  return result.rows as StoredRow[]
}

export async function fetchGrokbotRows(
  client: Queryable,
  sessionKey: string,
  agent?: string,
): Promise<Array<{ conversation: GrokbotConversation; rows: StoredRow[] }>> {
  return withReadOnlyTransaction(client, async (txn) => {
    const conversations = await listGrokbotConversations(txn, sessionKey, agent)
    const out: Array<{ conversation: GrokbotConversation; rows: StoredRow[] }> = []
    for (const conversation of conversations) {
      out.push({
        conversation,
        rows: await fetchRowsForConversation(txn, conversation.conversation_id),
      })
    }
    return out
  })
}

export async function connectAndFetchGrokbotRows(
  sessionKey: string,
  agent?: string,
): Promise<Array<{ conversation: GrokbotConversation; rows: StoredRow[] }>> {
  const url = loadRivetosPgUrlFromEnv()
  if (!url) {
    throw new Error(
      'reclean: RIVETOS_PG_URL is not set (environment or ~/.rivetos/.env). Do not pass the URL on argv.',
    )
  }
  const pool = new pg.Pool({ connectionString: url })
  const client = await pool.connect()
  try {
    return await fetchGrokbotRows(client, sessionKey, agent)
  } finally {
    client.release()
    await pool.end()
  }
}
