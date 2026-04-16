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
    await pool.query(
      `DELETE FROM ros_messages WHERE agent = $1`,
      [TEST_AGENT],
    )
    await pool.query(
      `DELETE FROM ros_conversations WHERE agent = $1`,
      [TEST_AGENT],
    )
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
