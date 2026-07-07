/**
 * Integration tests for PostgresMemory adapter.
 *
 * Requires a live Postgres connection — reads RIVETOS_PG_URL from env.
 * Skipped when the env var is not set (CI without a DB, etc.).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresMemory } from './adapter.ts'

const PG_URL = process.env.RIVETOS_PG_URL ?? ''
const TEST_AGENT = `test-agent-${Date.now()}`

// Gate the entire suite on having a database connection
const shouldRun = PG_URL.length > 0
const describeIf = shouldRun ? describe : describe.skip

describeIf('PostgresMemory.getContextForTurn', () => {
  let memory: PostgresMemory

  beforeAll(async () => {
    memory = new PostgresMemory({ connectionString: PG_URL })
    expect(await memory.isHealthy()).toBe(true)

    // Seed: one heartbeat message, one real user message
    await memory.append({
      sessionId: `heartbeat:${TEST_AGENT}`,
      agent: TEST_AGENT,
      channel: 'heartbeat',
      role: 'assistant',
      content: 'HEARTBEAT_OK',
    })

    await memory.append({
      sessionId: `telegram-${TEST_AGENT}`,
      agent: TEST_AGENT,
      channel: 'telegram',
      role: 'user',
      content: 'This is a real user message for testing',
    })
  })

  afterAll(async () => {
    // Clean up test rows
    const pool = memory.getPool()
    await pool.query(`DELETE FROM ros_messages WHERE agent = $1`, [TEST_AGENT])
    await pool.query(`DELETE FROM ros_conversations WHERE agent = $1`, [TEST_AGENT])
    await pool.end()
  })

  it('should exclude heartbeat sessions from the Recent section', async () => {
    const context = await memory.getContextForTurn('test query', TEST_AGENT)

    // The "## Recent" section should contain the real message
    const recentSection = context.split('## Relevant Context')[0]
    expect(recentSection).toContain('## Recent')
    expect(recentSection).toContain('This is a real user message for testing')

    // HEARTBEAT_OK should NOT appear in the Recent section
    expect(recentSection).not.toContain('HEARTBEAT_OK')
  })
})

describeIf('getContextForTurn wiki section (3f)', () => {
  const SLUG = `wiki-3f-test-${Date.now()}`
  let memory: PostgresMemory

  beforeAll(async () => {
    memory = new PostgresMemory({ connectionString: PG_URL })
    const pool = memory.getSearchEngine() // touch to init
    void pool
    // Seed a wiki topic directly (0005 applied on the test DB).
    await (memory as unknown as { pool: import('pg').Pool }).pool.query(
      `INSERT INTO ros_wiki_topics (slug, title, current_state, search_text)
       VALUES ($1, $2, $3, $2 || ' ' || $3)
       ON CONFLICT (slug) DO NOTHING`,
      [SLUG, 'Wiki 3f Probe Topic', 'The probe topic current state: flurbnozzle protocol v9 lives here.'],
    )
  })

  afterAll(async () => {
    await (memory as unknown as { pool: import('pg').Pool }).pool.query(
      'DELETE FROM ros_wiki_topics WHERE slug = $1',
      [SLUG],
    )
    await memory.close()
  })

  it('injects the curated section and dedups the exact same text from raw hits', async () => {
    const ctx = await memory.getContextForTurn('flurbnozzle protocol', 'wiki-3f-agent')
    expect(ctx).toContain('## Wiki (curated state)')
    expect(ctx).toContain(`wiki:${SLUG}`)
    expect(ctx).toContain('flurbnozzle protocol v9')
    // The same 300-char prefix must appear exactly once (dedup across sections).
    const occurrences = ctx.split('flurbnozzle protocol v9 lives here').length - 1
    expect(occurrences).toBe(1)
  })
})

