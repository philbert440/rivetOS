/**
 * Compaction Worker — Event-driven, runs on Datahub (CT110).
 *
 * Listens for Postgres NOTIFY on 'compaction_work' channel.
 * Picks up queue entries from ros_compaction_queue.
 * Calls Gemma-4-E2B on GERTY CPU (port 8001) for summarization.
 *
 * v5 pipeline:
 *   - prompts, formatters, constants imported from @rivetos/memory-postgres
 *   - rich message formatter: timestamps, agent, role, tool-call fallback
 *   - conversation preamble (surface/id/channel/title/span)
 *   - 7k / 14k / 20k leaf/branch/root token budgets, thinking enabled
 *   - async tool-call content synthesis (drains ros_tool_synth_queue)
 *
 * Hierarchy: messages → leaf → branch → root (bottom-up compaction).
 *
 * Triggers:
 *   - Message threshold (50+ unsummarized messages)
 *   - Session idle (15 min idle + 10+ unsummarized)
 *   - Explicit request (agent/API inserts queue entry)
 *
 * Single instance — no timers, no polling, no races (except the
 * tool-synth drain, which shares the processing lock so it never
 * collides with compaction work).
 */

import pg from 'pg'
import { Agent, fetch as undiciFetch } from 'undici'
import {
  LEAF_SYSTEM_PROMPT,
  BRANCH_SYSTEM_PROMPT,
  ROOT_SYSTEM_PROMPT,
  LEAF_MAX_TOKENS,
  BRANCH_MAX_TOKENS,
  ROOT_MAX_TOKENS,
  LLM_TIMEOUT_MS,
  LLM_TEMPERATURE,
  LLM_RETRIES,
  LLM_RETRY_BACKOFF_MS,
  MIN_BATCH_SIZE,
  MAX_CONVERSATIONS_PER_CYCLE,
  TOOL_SYNTH_QUEUE_TABLE,
  fmtIsoMinute,
  sanitizeForJson,
  formatLeafPrompt,
  formatBranchPrompt,
  formatRootPrompt,
  synthesizeToolCallContent,
} from '@rivetos/memory-postgres'

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const PG_URL = process.env.RIVETOS_PG_URL
if (!PG_URL) {
  console.error('[CompactWorker] RIVETOS_PG_URL is required')
  process.exit(1)
}

const LLM_URL = process.env.RIVETOS_COMPACTOR_URL
if (!LLM_URL) {
  console.error('[CompactWorker] RIVETOS_COMPACTOR_URL is required')
  process.exit(1)
}
const LLM_MODEL = process.env.RIVETOS_COMPACTOR_MODEL ?? 'rivet-refined-v5'
const LLM_API_KEY = process.env.RIVETOS_COMPACTOR_API_KEY ?? ''

// Batch sizes (worker-local — library exports only absolute budgets)
const LEAF_BATCH_SIZE = parseInt(process.env.COMPACT_LEAF_BATCH ?? '10', 10)
const BRANCH_BATCH_SIZE = parseInt(process.env.COMPACT_BRANCH_BATCH ?? '8', 10)
const ROOT_BATCH_SIZE = parseInt(process.env.COMPACT_ROOT_BATCH ?? '5', 10)

// Idle session detection
const IDLE_CHECK_INTERVAL_MS = parseInt(process.env.COMPACT_IDLE_CHECK_MS ?? '300000', 10)
const IDLE_MINUTES = parseInt(process.env.COMPACT_IDLE_MINUTES ?? '15', 10)
const MIN_UNSUMMARIZED = parseInt(process.env.COMPACT_MIN_UNSUMMARIZED ?? '50', 10)
const MIN_LEAFS_FOR_BRANCH = parseInt(process.env.COMPACT_MIN_LEAFS ?? '5', 10)
const MIN_BRANCHES_FOR_ROOT = parseInt(process.env.COMPACT_MIN_BRANCHES ?? '3', 10)

// Tool-synth drain
const TOOL_SYNTH_MODEL = process.env.TOOL_SYNTH_MODEL ?? LLM_MODEL
const TOOL_SYNTH_ENDPOINT = process.env.TOOL_SYNTH_ENDPOINT ?? LLM_URL
const TOOL_SYNTH_BATCH_SIZE = parseInt(process.env.TOOL_SYNTH_BATCH_SIZE ?? '4', 10)
const TOOL_SYNTH_INTERVAL_MS = parseInt(process.env.TOOL_SYNTH_INTERVAL_MS ?? '30000', 10)
const TOOL_SYNTH_MAX_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let processing = false
let drainRequested = false
const metrics = {
  leafsCreated: 0,
  branchesCreated: 0,
  rootsCreated: 0,
  llmCalls: 0,
  llmFailures: 0,
  toolSynthDone: 0,
  toolSynthFailed: 0,
}

// Circuit breaker — skip conversations that repeatedly fail LLM summarization
const CIRCUIT_BREAKER_THRESHOLD = 3
const CIRCUIT_BREAKER_RESET_MS = 3_600_000 // 1 hour
const circuitBreaker = new Map() // conversationId → { failures, lastFailAt }

// ---------------------------------------------------------------------------
// Pool + hardened undici dispatcher
// ---------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: PG_URL, max: 4 })
pool.on('error', (err) => {
  console.error('[CompactWorker] Pool error:', err.message)
})

const httpDispatcher = new Agent({
  headersTimeout: 0, // rely on AbortSignal only
  bodyTimeout: 0,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  connect: { timeout: 30_000 },
  pipelining: 0,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Listener — dedicated connection for LISTEN/NOTIFY
// ---------------------------------------------------------------------------

let listenerClient = null
const MAX_RECONNECT_DELAY = 60_000
let reconnectDelay = 5_000

async function startListener() {
  if (listenerClient) {
    try {
      listenerClient.removeAllListeners()
      await listenerClient.end()
    } catch (_) {
      // ignore cleanup errors
    }
    listenerClient = null
  }

  const client = new pg.Client({ connectionString: PG_URL })
  listenerClient = client

  client.on('error', (err) => {
    console.error('[CompactWorker] Listener connection error:', err.message)
    scheduleReconnect()
  })

  try {
    await client.connect()
    await client.query('LISTEN compaction_work')
    console.log('[CompactWorker] Listening on channel: compaction_work')
    reconnectDelay = 5_000

    client.on('notification', (_msg) => {
      if (!processing) {
        void processQueue()
      } else {
        drainRequested = true
      }
    })
  } catch (err) {
    console.error('[CompactWorker] Failed to connect listener:', err.message)
    scheduleReconnect()
    return null
  }

  return client
}

function scheduleReconnect() {
  console.log(`[CompactWorker] Reconnecting listener in ${reconnectDelay / 1000}s...`)
  setTimeout(() => {
    startListener().catch((e) =>
      console.error('[CompactWorker] Reconnect failed:', e.message),
    )
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

// ---------------------------------------------------------------------------
// LLM call — hardened undici client, thinking enabled
// ---------------------------------------------------------------------------

async function callLlm(systemPrompt, userContent, maxTokens) {
  metrics.llmCalls++

  const headers = { 'Content-Type': 'application/json' }
  if (LLM_API_KEY) {
    headers['Authorization'] = `Bearer ${LLM_API_KEY}`
  }

  const body = JSON.stringify({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: maxTokens,
    temperature: LLM_TEMPERATURE,
    // Full thinking enabled — no enable_thinking: false
  })

  let lastError = null

  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS)

    try {
      const response = await undiciFetch(`${LLM_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
        dispatcher: httpDispatcher,
      })

      // Non-retryable error (4xx)
      if (!response.ok && response.status < 500) {
        metrics.llmFailures++
        console.error(
          `[CompactWorker] LLM returned ${response.status}: ${response.statusText} (not retrying)`,
        )
        return null
      }

      // Retryable error (5xx, server overloaded, etc.)
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`)
        if (attempt < LLM_RETRIES) {
          const delay = LLM_RETRY_BACKOFF_MS * Math.pow(2, attempt)
          console.error(
            `[CompactWorker] LLM ${response.status}, retry ${attempt + 1}/${LLM_RETRIES} in ${delay / 1000}s`,
          )
          await sleep(delay)
          continue
        }
        break
      }

      const data = await response.json()
      const message = data.choices?.[0]?.message

      // Support both content and reasoning_content (thinking models)
      const content = message?.content ?? message?.reasoning_content ?? null

      if (!content || content.trim().length < 20) {
        lastError = new Error('Empty or too-short LLM response')
        if (attempt < LLM_RETRIES) {
          const delay = LLM_RETRY_BACKOFF_MS * Math.pow(2, attempt)
          console.error(
            `[CompactWorker] LLM returned empty/short content, retry ${attempt + 1}/${LLM_RETRIES} in ${delay / 1000}s`,
          )
          await sleep(delay)
          continue
        }
        break
      }

      return content
    } catch (err) {
      lastError = err
      if (attempt < LLM_RETRIES) {
        const delay = LLM_RETRY_BACKOFF_MS * Math.pow(2, attempt)
        console.error(
          `[CompactWorker] LLM error: ${err.message}, retry ${attempt + 1}/${LLM_RETRIES} in ${delay / 1000}s`,
        )
        await sleep(delay)
        continue
      }
      break
    } finally {
      clearTimeout(timeout)
    }
  }

  metrics.llmFailures++
  console.error(
    `[CompactWorker] LLM call failed after ${LLM_RETRIES + 1} attempts: ${lastError?.message}`,
  )
  return null
}

// ---------------------------------------------------------------------------
// Conversation meta (for preamble)
// ---------------------------------------------------------------------------

async function loadConversationMeta(conversationId) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, agent, channel, channel_id, title
       FROM ros_conversations
      WHERE id = $1`,
    [conversationId],
  )
  if (rows.length === 0) {
    throw new Error(`Conversation not found: ${conversationId}`)
  }
  return rows[0]
}

// ---------------------------------------------------------------------------
// Leaf compaction (messages → leaf summary) — v5 formatter
// ---------------------------------------------------------------------------

async function compactLeafConversation(conversationId) {
  const convMeta = await loadConversationMeta(conversationId)

  const messages = await pool.query(
    `SELECT m.id, m.role, m.content, m.agent, m.created_at, m.tool_name, m.tool_args
     FROM ros_messages m
     LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
     WHERE ss.summary_id IS NULL AND m.conversation_id = $1
       AND (
         (m.content IS NOT NULL AND LENGTH(m.content) > 10)
      OR m.tool_name IS NOT NULL
       )
     ORDER BY m.created_at ASC LIMIT $2`,
    [conversationId, LEAF_BATCH_SIZE],
  )

  if (messages.rows.length < MIN_BATCH_SIZE) return 0

  const formatted = formatLeafPrompt(convMeta, messages.rows)

  console.log(
    `[CompactWorker] Leaf: summarizing ${messages.rows.length} messages for ${conversationId.slice(0, 8)}…`,
  )

  const summaryText = await callLlm(LEAF_SYSTEM_PROMPT, formatted, LEAF_MAX_TOKENS)
  if (!summaryText) {
    const entry = circuitBreaker.get(conversationId) ?? { failures: 0, lastFailAt: 0 }
    entry.failures++
    entry.lastFailAt = Date.now()
    circuitBreaker.set(conversationId, entry)
    console.error(
      `[CompactWorker] Empty leaf summary for ${conversationId.slice(0, 8)}… ` +
        `(failure ${entry.failures}/${CIRCUIT_BREAKER_THRESHOLD})`,
    )
    return 0
  }

  circuitBreaker.delete(conversationId)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const sumResult = await client.query(
      `INSERT INTO ros_summaries
         (conversation_id, depth, content, kind, message_count, earliest_at, latest_at, model)
       VALUES ($1, 0, $2, 'leaf', $3, $4, $5, $6) RETURNING id`,
      [
        conversationId,
        summaryText,
        messages.rows.length,
        messages.rows[0].created_at,
        messages.rows[messages.rows.length - 1].created_at,
        LLM_MODEL,
      ],
    )
    const summaryId = sumResult.rows[0].id

    const values = []
    const params = []
    let pi = 1
    for (let i = 0; i < messages.rows.length; i++) {
      values.push(`($${pi}, $${pi + 1}, $${pi + 2})`)
      params.push(summaryId, messages.rows[i].id, i)
      pi += 3
    }
    await client.query(
      `INSERT INTO ros_summary_sources (summary_id, message_id, ordinal) VALUES ${values.join(', ')}`,
      params,
    )

    await client.query('COMMIT')
    metrics.leafsCreated++
    console.log(
      `[CompactWorker] Leaf ${summaryId} created (${messages.rows.length} msgs, conv ${conversationId.slice(0, 8)}…)`,
    )
    return 1
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// Branch compaction (leaves → branch summary) — v5 formatter
// ---------------------------------------------------------------------------

async function compactBranchConversation(conversationId) {
  const convMeta = await loadConversationMeta(conversationId)

  const leaves = await pool.query(
    `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
     FROM ros_summaries
     WHERE conversation_id = $1 AND kind = 'leaf' AND parent_id IS NULL
     ORDER BY created_at ASC LIMIT $2`,
    [conversationId, BRANCH_BATCH_SIZE],
  )

  if (leaves.rows.length < MIN_LEAFS_FOR_BRANCH) return 0

  const formatted = formatBranchPrompt(convMeta, leaves.rows)

  console.log(
    `[CompactWorker] Branch: summarizing ${leaves.rows.length} leaves for ${conversationId.slice(0, 8)}…`,
  )

  const summaryText = await callLlm(BRANCH_SYSTEM_PROMPT, formatted, BRANCH_MAX_TOKENS)
  if (!summaryText) {
    console.error(`[CompactWorker] Empty branch summary for ${conversationId}`)
    return 0
  }

  const totalMessages = leaves.rows.reduce((sum, r) => sum + r.message_count, 0)
  const earliestAt = leaves.rows[0].earliest_at ?? leaves.rows[0].created_at
  const lastLeaf = leaves.rows[leaves.rows.length - 1]
  const latestAt = lastLeaf.latest_at ?? lastLeaf.created_at

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const sumResult = await client.query(
      `INSERT INTO ros_summaries
         (conversation_id, depth, content, kind, message_count, earliest_at, latest_at, model)
       VALUES ($1, 1, $2, 'branch', $3, $4, $5, $6) RETURNING id`,
      [conversationId, summaryText, totalMessages, earliestAt, latestAt, LLM_MODEL],
    )
    const branchId = sumResult.rows[0].id

    const leafIds = leaves.rows.map((r) => r.id)
    await client.query(
      `UPDATE ros_summaries SET parent_id = $1 WHERE id = ANY($2::uuid[])`,
      [branchId, leafIds],
    )

    await client.query('COMMIT')
    metrics.branchesCreated++
    console.log(
      `[CompactWorker] Branch ${branchId} created (${leaves.rows.length} leaves, ${totalMessages} msgs, conv ${conversationId.slice(0, 8)}…)`,
    )
    return 1
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// Root compaction (branches → root summary) — v5 formatter
// ---------------------------------------------------------------------------

async function compactRootConversation(conversationId) {
  const convMeta = await loadConversationMeta(conversationId)

  const branches = await pool.query(
    `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
     FROM ros_summaries
     WHERE conversation_id = $1 AND kind = 'branch' AND parent_id IS NULL
     ORDER BY created_at ASC LIMIT $2`,
    [conversationId, ROOT_BATCH_SIZE],
  )

  if (branches.rows.length < MIN_BRANCHES_FOR_ROOT) return 0

  const formatted = formatRootPrompt(convMeta, branches.rows)

  console.log(
    `[CompactWorker] Root: summarizing ${branches.rows.length} branches for ${conversationId.slice(0, 8)}…`,
  )

  const summaryText = await callLlm(ROOT_SYSTEM_PROMPT, formatted, ROOT_MAX_TOKENS)
  if (!summaryText) {
    console.error(`[CompactWorker] Empty root summary for ${conversationId}`)
    return 0
  }

  const totalMessages = branches.rows.reduce((sum, r) => sum + r.message_count, 0)
  const earliestAt = branches.rows[0].earliest_at ?? branches.rows[0].created_at
  const lastBranch = branches.rows[branches.rows.length - 1]
  const latestAt = lastBranch.latest_at ?? lastBranch.created_at

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const sumResult = await client.query(
      `INSERT INTO ros_summaries
         (conversation_id, depth, content, kind, message_count, earliest_at, latest_at, model)
       VALUES ($1, 2, $2, 'root', $3, $4, $5, $6) RETURNING id`,
      [conversationId, summaryText, totalMessages, earliestAt, latestAt, LLM_MODEL],
    )
    const rootId = sumResult.rows[0].id

    const branchIds = branches.rows.map((r) => r.id)
    await client.query(
      `UPDATE ros_summaries SET parent_id = $1 WHERE id = ANY($2::uuid[])`,
      [rootId, branchIds],
    )

    await client.query('COMMIT')
    metrics.rootsCreated++
    console.log(
      `[CompactWorker] Root ${rootId} created (${branches.rows.length} branches, ${totalMessages} msgs, conv ${conversationId.slice(0, 8)}…)`,
    )
    return 1
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
// Process a single conversation — full bottom-up compaction
// ---------------------------------------------------------------------------

async function compactConversation(conversationId) {
  const cb = circuitBreaker.get(conversationId)
  if (cb && cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    if (Date.now() - cb.lastFailAt < CIRCUIT_BREAKER_RESET_MS) {
      console.log(
        `[CompactWorker] Circuit breaker: skipping ${conversationId.slice(0, 8)}… ` +
          `(${cb.failures} consecutive failures, will retry after reset)`,
      )
      return 0
    }
    circuitBreaker.delete(conversationId)
    console.log(`[CompactWorker] Circuit breaker reset for ${conversationId.slice(0, 8)}…`)
  }

  let totalCreated = 0

  let leafRound = 0
  while (leafRound < 10) {
    const created = await compactLeafConversation(conversationId)
    if (created === 0) break
    totalCreated += created
    leafRound++
  }

  if (totalCreated > 0) {
    circuitBreaker.delete(conversationId)
  }

  const branchCreated = await compactBranchConversation(conversationId)
  totalCreated += branchCreated

  const rootCreated = await compactRootConversation(conversationId)
  totalCreated += rootCreated

  return totalCreated
}

// ---------------------------------------------------------------------------
// Process queue
// ---------------------------------------------------------------------------

const STALE_LOCK_MINUTES = 15

async function processQueue() {
  if (processing) return
  processing = true

  try {
    const recovered = await pool.query(
      `UPDATE ros_compaction_queue
       SET status = 'pending', locked_at = NULL
       WHERE status = 'processing'
         AND locked_at < NOW() - interval '${STALE_LOCK_MINUTES} minutes'
       RETURNING id`,
    )
    if (recovered.rowCount > 0) {
      console.log(`[CompactWorker] Recovered ${recovered.rowCount} stale lock(s)`)
    }

    let totalProcessed = 0

    do {
      drainRequested = false

      const pending = await pool.query(
        `UPDATE ros_compaction_queue
         SET status = 'processing', locked_at = NOW()
         WHERE id IN (
           SELECT id FROM ros_compaction_queue
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT $1
         )
         RETURNING id, conversation_id, trigger_type`,
        [MAX_CONVERSATIONS_PER_CYCLE],
      )

      if (pending.rows.length === 0) break

      console.log(
        `[CompactWorker] Processing ${pending.rows.length} conversation(s)`,
      )

      for (const row of pending.rows) {
        try {
          const created = await compactConversation(row.conversation_id)

          await pool.query(
            `UPDATE ros_compaction_queue SET status = 'done' WHERE id = $1`,
            [row.id],
          )

          if (created > 0) {
            totalProcessed += created
            console.log(
              `[CompactWorker] Done: conv ${row.conversation_id.slice(0, 8)}… (${created} summaries, trigger: ${row.trigger_type})`,
            )
          }
        } catch (err) {
          console.error(
            `[CompactWorker] Failed conv ${row.conversation_id.slice(0, 8)}…: ${err.message}`,
          )
          await pool.query(
            `UPDATE ros_compaction_queue
             SET status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'pending' END,
                 attempts = attempts + 1,
                 last_error = $1,
                 locked_at = NULL
             WHERE id = $2`,
            [err.message, row.id],
          )
        }
      }
    } while (drainRequested)

    if (totalProcessed > 0) {
      console.log(
        `[CompactWorker] Cycle done: ${totalProcessed} summaries ` +
          `(leafs: ${metrics.leafsCreated}, branches: ${metrics.branchesCreated}, roots: ${metrics.rootsCreated}, ` +
          `llm calls: ${metrics.llmCalls}, failures: ${metrics.llmFailures})`,
      )
    }
  } catch (err) {
    console.error(`[CompactWorker] processQueue error: ${err.message}`)
  } finally {
    processing = false

    if (drainRequested) {
      drainRequested = false
      void processQueue()
    }
  }
}

// ---------------------------------------------------------------------------
// Idle session detection — periodic check
// ---------------------------------------------------------------------------

async function checkIdleSessions() {
  if (processing) return

  try {
    const result = await pool.query(
      `SELECT enqueue_idle_sessions($1, $2) AS enqueued`,
      [IDLE_MINUTES, MIN_UNSUMMARIZED],
    )
    const enqueued = result.rows[0]?.enqueued ?? 0
    if (enqueued > 0) {
      console.log(`[CompactWorker] Idle check: enqueued ${enqueued} conversation(s)`)
    }
  } catch (err) {
    console.error(`[CompactWorker] Idle check failed: ${err.message}`)
  }
}

// ---------------------------------------------------------------------------
// Tool-synth queue drain — async consumer for v5 tool-call content synthesis
// ---------------------------------------------------------------------------

async function drainToolSynthQueue() {
  if (processing) return // share lock with main compaction to avoid LLM contention

  // Claim a batch of rows — use SKIP LOCKED so multiple workers would never collide
  const client = await pool.connect()
  let claimed = []
  try {
    await client.query('BEGIN')

    const rows = await client.query(
      `SELECT q.message_id, m.tool_name, m.tool_args, m.agent, m.created_at
       FROM ${TOOL_SYNTH_QUEUE_TABLE} q
       JOIN ros_messages m ON m.id = q.message_id
       WHERE q.attempts < $1
       ORDER BY q.enqueued_at ASC
       LIMIT $2
       FOR UPDATE OF q SKIP LOCKED`,
      [TOOL_SYNTH_MAX_ATTEMPTS, TOOL_SYNTH_BATCH_SIZE],
    )
    claimed = rows.rows

    // Mark in-flight rows so other drain ticks do not re-pick them
    if (claimed.length > 0) {
      await client.query(
        `UPDATE ${TOOL_SYNTH_QUEUE_TABLE}
           SET last_attempt_at = NOW()
         WHERE message_id = ANY($1::uuid[])`,
        [claimed.map((r) => r.message_id)],
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[ToolSynth] Claim failed:', err.message)
    client.release()
    return
  } finally {
    client.release()
  }

  if (claimed.length === 0) return

  console.log(`[ToolSynth] Draining ${claimed.length} tool-call message(s)`)

  for (const row of claimed) {
    try {
      const toolArgs =
        typeof row.tool_args === 'string'
          ? JSON.parse(row.tool_args || '{}')
          : (row.tool_args ?? {})

      const synth = await synthesizeToolCallContent({
        endpoint: TOOL_SYNTH_ENDPOINT,
        model: TOOL_SYNTH_MODEL,
        apiKey: LLM_API_KEY,
        toolName: row.tool_name,
        toolArgs,
      })

      if (!synth || synth.trim().length === 0) {
        throw new Error('Empty synth response')
      }

      // Swap content + remove queue entry
      const update = await pool.connect()
      try {
        await update.query('BEGIN')
        // NOTE: ros_messages has no updated_at column — do not add it here.
        await update.query(`UPDATE ros_messages SET content = $1 WHERE id = $2`, [
          synth,
          row.message_id,
        ])
        await update.query(
          `DELETE FROM ${TOOL_SYNTH_QUEUE_TABLE} WHERE message_id = $1`,
          [row.message_id],
        )
        await update.query('COMMIT')
      } catch (writeErr) {
        await update.query('ROLLBACK').catch(() => {})
        throw writeErr
      } finally {
        update.release()
      }

      metrics.toolSynthDone++
      console.log(`[ToolSynth] ✓ ${row.tool_name} → ${synth.slice(0, 80)}`)
    } catch (err) {
      const errMsg = err?.message ?? String(err)
      const c = await pool.connect()
      try {
        const { rows: attemptRows } = await c.query(
          `UPDATE ${TOOL_SYNTH_QUEUE_TABLE}
             SET attempts = attempts + 1,
                 last_error = $1,
                 last_attempt_at = NOW()
           WHERE message_id = $2
           RETURNING attempts`,
          [errMsg, row.message_id],
        )
        const attempts = attemptRows[0]?.attempts ?? TOOL_SYNTH_MAX_ATTEMPTS

        if (attempts >= TOOL_SYNTH_MAX_ATTEMPTS) {
          // Max attempts reached. Do NOT write fallback content — low-signal
          // strings like "Called exec tool with arguments." pollute search.
          // Leave the queue row in place with attempts=MAX so `memory
          // queue-status` surfaces it as stuck; an operator can requeue.
          metrics.toolSynthFailed++
          console.log(
            `[ToolSynth] ✗ ${row.tool_name} (giving up after ${attempts} attempts; row left stuck): ${errMsg}`,
          )
        } else {
          console.warn(
            `[ToolSynth] Retry ${attempts}/${TOOL_SYNTH_MAX_ATTEMPTS} for ${row.tool_name}: ${errMsg}`,
          )
        }
      } catch (updErr) {
        console.error('[ToolSynth] Failure-bookkeeping error:', updErr.message)
      } finally {
        c.release()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  console.log('[CompactWorker] Starting...')
  console.log(`[CompactWorker] LLM endpoint: ${LLM_URL} (model: ${LLM_MODEL})`)
  console.log(
    `[CompactWorker] Timeout: ${LLM_TIMEOUT_MS / 1000}s, Leaf tokens: ${LEAF_MAX_TOKENS}, Branch: ${BRANCH_MAX_TOKENS}, Root: ${ROOT_MAX_TOKENS}`,
  )
  console.log(
    `[CompactWorker] Thresholds — unsummarized: ${MIN_UNSUMMARIZED}, leafs→branch: ${MIN_LEAFS_FOR_BRANCH}, branches→root: ${MIN_BRANCHES_FOR_ROOT}`,
  )

  await startListener()

  await processQueue()

  await checkIdleSessions()

  setInterval(() => void checkIdleSessions(), IDLE_CHECK_INTERVAL_MS)

  setInterval(async () => {
    try {
      const result = await pool.query(
        `DELETE FROM ros_compaction_queue
         WHERE status = 'done' AND completed_at < NOW() - interval '24 hours'
         RETURNING id`,
      )
      if (result.rowCount > 0) {
        console.log(`[CompactWorker] Cleanup: removed ${result.rowCount} old queue entries`)
      }
    } catch (err) {
      console.error(`[CompactWorker] Cleanup failed: ${err.message}`)
    }
  }, 60 * 60 * 1000) // Every hour

  // v5 tool-synth queue drain
  setInterval(() => void drainToolSynthQueue(), TOOL_SYNTH_INTERVAL_MS)
  console.log(
    `[CompactWorker] Tool-synth drain active (every ${TOOL_SYNTH_INTERVAL_MS}ms, batch ${TOOL_SYNTH_BATCH_SIZE})`,
  )

  // Use imported helpers to avoid unused warnings in future simplifications
  void fmtIsoMinute
  void sanitizeForJson

  console.log('[CompactWorker] Ready — waiting for notifications')
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  console.log(`[CompactWorker] ${signal} — shutting down`)
  try {
    if (listenerClient) {
      await listenerClient.end().catch(() => {})
    }
    await pool.end().catch(() => {})
  } finally {
    process.exit(0)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

main().catch((err) => {
  console.error('[CompactWorker] Fatal:', err)
  process.exit(1)
})
