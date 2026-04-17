/**
 * Compaction Worker — Event-driven, runs on Datahub (CT110).
 *
 * Listens for Postgres NOTIFY on 'compaction_work' channel.
 * Picks up queue entries from ros_compaction_queue.
 * Calls Gemma-4-E2B on GERTY CPU (port 8001) for summarization.
 * Full thinking enabled — smart summaries, generous token budget.
 *
 * Hierarchy: messages → leaf → branch → root (bottom-up compaction).
 *
 * Triggers:
 *   - Message threshold (50+ unsummarized messages)
 *   - Session idle (15 min idle + 10+ unsummarized)
 *   - Explicit request (agent/API inserts queue entry)
 *
 * Single instance — no timers, no polling, no races.
 */

import pg from 'pg'

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const PG_URL = process.env.RIVETOS_PG_URL
if (!PG_URL) {
  console.error('[CompactWorker] RIVETOS_PG_URL is required')
  process.exit(1)
}

const LLM_URL = process.env.RIVETOS_COMPACTOR_URL
if (!LLM_URL) { console.error('RIVETOS_COMPACTOR_URL is required'); process.exit(1) }
const LLM_MODEL = process.env.RIVETOS_COMPACTOR_MODEL ?? 'gemma-4-E2B-it-Q4_K_M.gguf'
const LLM_API_KEY = process.env.RIVETOS_COMPACTOR_API_KEY ?? ''

// Timeouts and budgets — generous for thinking model
const LLM_TIMEOUT_MS = parseInt(process.env.COMPACT_LLM_TIMEOUT_MS ?? '600000', 10) // 10 minutes
const LEAF_MAX_TOKENS = parseInt(process.env.COMPACT_LEAF_TOKENS ?? '4096', 10)
const BRANCH_MAX_TOKENS = parseInt(process.env.COMPACT_BRANCH_TOKENS ?? '6144', 10)
const ROOT_MAX_TOKENS = parseInt(process.env.COMPACT_ROOT_TOKENS ?? '8192', 10)
const LLM_TEMPERATURE = parseFloat(process.env.COMPACT_TEMPERATURE ?? '0.3')

// Batch sizes
const LEAF_BATCH_SIZE = parseInt(process.env.COMPACT_LEAF_BATCH ?? '10', 10)
const MIN_BATCH_SIZE = 5
const MIN_UNSUMMARIZED = parseInt(process.env.COMPACT_MIN_UNSUMMARIZED ?? '10', 10)
const MIN_LEAFS_FOR_BRANCH = parseInt(process.env.COMPACT_MIN_LEAFS ?? '5', 10)
const BRANCH_BATCH_SIZE = parseInt(process.env.COMPACT_BRANCH_BATCH ?? '8', 10)
const MIN_BRANCHES_FOR_ROOT = parseInt(process.env.COMPACT_MIN_BRANCHES ?? '3', 10)
const ROOT_BATCH_SIZE = parseInt(process.env.COMPACT_ROOT_BATCH ?? '5', 10)
const MAX_CONVERSATIONS_PER_CYCLE = 5

// Session idle detection interval
const IDLE_CHECK_INTERVAL_MS = parseInt(process.env.COMPACT_IDLE_CHECK_MS ?? '300000', 10) // 5 min
const IDLE_MINUTES = parseInt(process.env.COMPACT_IDLE_MINUTES ?? '15', 10)

// Content limits in prompts
const MAX_MSG_CONTENT = 1000
const MAX_SUMMARY_CONTENT = 2000

// ---------------------------------------------------------------------------
// Prompts — level-specific
// ---------------------------------------------------------------------------

const LEAF_SYSTEM_PROMPT =
  'Summarize these conversation messages concisely. Preserve: key decisions, ' +
  'technical details, configurations, action items, state changes, problems solved, ' +
  'and any code snippets or commands that were used. ' +
  'Format as bullet points. Be specific — include names, values, and outcomes.'

const BRANCH_SYSTEM_PROMPT =
  'You are summarizing a series of conversation summaries into a higher-level overview. ' +
  'These summaries represent a period of conversation in a single thread. ' +
  'Identify the main themes, key decisions, and outcomes across all the summaries. ' +
  'Preserve: project names, architectural decisions, configuration changes, ' +
  'problems solved, and action items. Drop low-value details. ' +
  'Format as bullet points organized by theme.'

const ROOT_SYSTEM_PROMPT =
  'You are creating a top-level summary of an entire conversation thread from branch summaries. ' +
  'Each branch covers a significant period of discussion. ' +
  'Distill the most important decisions, outcomes, and state changes. ' +
  'This summary should give someone full context on what happened in this conversation. ' +
  'Preserve: final decisions (not deliberation), completed actions, ' +
  'current state of systems/projects, and any unresolved issues. ' +
  'Format as bullet points. Be concise but complete.'

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
}

// Circuit breaker — skip conversations that repeatedly fail LLM summarization
const CIRCUIT_BREAKER_THRESHOLD = 3
const CIRCUIT_BREAKER_RESET_MS = 3_600_000 // 1 hour
const circuitBreaker = new Map() // conversationId → { failures, lastFailAt }

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: PG_URL, max: 4 })
pool.on('error', (err) => {
  console.error('[CompactWorker] Pool error:', err.message)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(d) {
  return d?.toISOString?.().split('T')[0] ?? '?'
}

/**
 * Strip lone surrogates and non-whitespace ASCII control characters.
 */
function sanitize(text) {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\x00-\x08\x0B\x0C\x0E-\x1F]/g,
    '',
  )
}

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
  // Clean up previous listener if it exists
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
    reconnectDelay = 5_000 // reset on success

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
// LLM call — full thinking enabled
// ---------------------------------------------------------------------------

const LLM_MAX_RETRIES = parseInt(process.env.COMPACT_LLM_RETRIES ?? '2', 10)

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
    // The model will reason deeply before producing the summary
  })

  let lastError = null

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${LLM_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
        if (attempt < LLM_MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 5_000 // 5s, 10s — longer for LLM
          console.error(
            `[CompactWorker] LLM ${response.status}, retry ${attempt + 1}/${LLM_MAX_RETRIES} in ${delay / 1000}s`,
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

      // Guard against empty responses — retry if we got nothing useful
      if (!content || content.trim().length < 20) {
        lastError = new Error('Empty or too-short LLM response')
        if (attempt < LLM_MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 5_000
          console.error(
            `[CompactWorker] LLM returned empty/short content, retry ${attempt + 1}/${LLM_MAX_RETRIES} in ${delay / 1000}s`,
          )
          await sleep(delay)
          continue
        }
        break
      }

      return content
    } catch (err) {
      lastError = err

      // Timeout or network error — retry
      if (attempt < LLM_MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 5_000
        console.error(
          `[CompactWorker] LLM error: ${err.message}, retry ${attempt + 1}/${LLM_MAX_RETRIES} in ${delay / 1000}s`,
        )
        await sleep(delay)
        continue
      }
      break
    }
  }

  metrics.llmFailures++
  console.error(
    `[CompactWorker] LLM call failed after ${LLM_MAX_RETRIES + 1} attempts: ${lastError?.message}`,
  )
  return null
}

// ---------------------------------------------------------------------------
// Leaf compaction (messages → leaf summary)
// ---------------------------------------------------------------------------

async function compactLeafConversation(conversationId) {
  const messages = await pool.query(
    `SELECT m.id, m.role, m.content, m.agent, m.created_at
     FROM ros_messages m
     LEFT JOIN ros_summary_sources ss ON ss.message_id = m.id
     WHERE ss.summary_id IS NULL AND m.conversation_id = $1
       AND m.content IS NOT NULL AND LENGTH(m.content) > 10
     ORDER BY m.created_at ASC LIMIT $2`,
    [conversationId, LEAF_BATCH_SIZE],
  )

  if (messages.rows.length < MIN_BATCH_SIZE) return 0

  const formatted = messages.rows
    .map((m) => `[${m.role}] ${sanitize(m.content.slice(0, MAX_MSG_CONTENT))}`)
    .join('\n')

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

    // Batch link source messages
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
// Branch compaction (leaves → branch summary)
// ---------------------------------------------------------------------------

async function compactBranchConversation(conversationId) {
  const leaves = await pool.query(
    `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
     FROM ros_summaries
     WHERE conversation_id = $1 AND kind = 'leaf' AND parent_id IS NULL
     ORDER BY created_at ASC LIMIT $2`,
    [conversationId, BRANCH_BATCH_SIZE],
  )

  if (leaves.rows.length < MIN_LEAFS_FOR_BRANCH) return 0

  const formatted = leaves.rows
    .map((s, i) => {
      const period =
        s.earliest_at && s.latest_at
          ? `${fmtDate(s.earliest_at)} → ${fmtDate(s.latest_at)}`
          : fmtDate(s.created_at)
      return `[Leaf ${i + 1}, ${period}, ${s.message_count} msgs]\n${sanitize(s.content.slice(0, MAX_SUMMARY_CONTENT))}`
    })
    .join('\n\n')

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
// Root compaction (branches → root summary)
// ---------------------------------------------------------------------------

async function compactRootConversation(conversationId) {
  const branches = await pool.query(
    `SELECT id, content, kind, earliest_at, latest_at, message_count, created_at
     FROM ros_summaries
     WHERE conversation_id = $1 AND kind = 'branch' AND parent_id IS NULL
     ORDER BY created_at ASC LIMIT $2`,
    [conversationId, ROOT_BATCH_SIZE],
  )

  if (branches.rows.length < MIN_BRANCHES_FOR_ROOT) return 0

  const formatted = branches.rows
    .map((s, i) => {
      const period =
        s.earliest_at && s.latest_at
          ? `${fmtDate(s.earliest_at)} → ${fmtDate(s.latest_at)}`
          : fmtDate(s.created_at)
      return `[Branch ${i + 1}, ${period}, ${s.message_count} msgs]\n${sanitize(s.content.slice(0, MAX_SUMMARY_CONTENT))}`
    })
    .join('\n\n')

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
  // Circuit breaker: skip conversations that repeatedly fail
  const cb = circuitBreaker.get(conversationId)
  if (cb && cb.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    if (Date.now() - cb.lastFailAt < CIRCUIT_BREAKER_RESET_MS) {
      console.log(
        `[CompactWorker] Circuit breaker: skipping ${conversationId.slice(0, 8)}… ` +
          `(${cb.failures} consecutive failures, will retry after reset)`,
      )
      return 0
    }
    // Reset window expired — give it another chance
    circuitBreaker.delete(conversationId)
    console.log(`[CompactWorker] Circuit breaker reset for ${conversationId.slice(0, 8)}…`)
  }

  let totalCreated = 0

  // Leaf compaction: keep creating leaves until we run out of unsummarized messages
  let leafRound = 0
  while (leafRound < 10) {
    // safety cap
    const created = await compactLeafConversation(conversationId)
    if (created === 0) break
    totalCreated += created
    leafRound++
  }

  // Clear circuit breaker on success
  if (totalCreated > 0) {
    circuitBreaker.delete(conversationId)
  }

  // Branch compaction: roll up leaves
  const branchCreated = await compactBranchConversation(conversationId)
  totalCreated += branchCreated

  // Root compaction: roll up branches
  const rootCreated = await compactRootConversation(conversationId)
  totalCreated += rootCreated

  return totalCreated
}

// ---------------------------------------------------------------------------
// Process queue
// ---------------------------------------------------------------------------

const STALE_LOCK_MINUTES = 15 // If locked for >15 min, assume the worker crashed

async function processQueue() {
  if (processing) return
  processing = true

  try {
    // Recover stale locks — entries stuck in 'processing' from a previous crash
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

      // Pick up pending queue entries
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

          // Mark done
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
  if (processing) return // Don't interfere with active compaction

  try {
    const result = await pool.query(
      `SELECT enqueue_idle_sessions($1, $2) AS enqueued`,
      [IDLE_MINUTES, MIN_UNSUMMARIZED],
    )
    const enqueued = result.rows[0]?.enqueued ?? 0
    if (enqueued > 0) {
      console.log(`[CompactWorker] Idle check: enqueued ${enqueued} conversation(s)`)
      // NOTIFY was already sent by the function, processQueue will fire from listener
    }
  } catch (err) {
    console.error(`[CompactWorker] Idle check failed: ${err.message}`)
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

  // Start listener
  await startListener()

  // Process any existing queue entries on startup
  await processQueue()

  // Check for idle sessions initially
  await checkIdleSessions()

  // Periodic idle session check
  setInterval(() => void checkIdleSessions(), IDLE_CHECK_INTERVAL_MS)

  // Periodic cleanup: remove completed queue entries older than 24h
  setInterval(async () => {
    try {
      const result = await pool.query(
        `DELETE FROM ros_compaction_queue
         WHERE status IN ('done', 'failed')
           AND created_at < NOW() - interval '24 hours'`,
      )
      if (result.rowCount > 0) {
        console.log(`[CompactWorker] Cleaned ${result.rowCount} old queue entries`)
      }
    } catch (err) {
      console.error(`[CompactWorker] Cleanup failed: ${err.message}`)
    }
  }, 60 * 60 * 1000) // Every hour

  console.log('[CompactWorker] Ready — waiting for notifications')
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[CompactWorker] SIGTERM received, shutting down...')
  await pool.end()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('[CompactWorker] SIGINT received, shutting down...')
  await pool.end()
  process.exit(0)
})

main().catch((err) => {
  console.error('[CompactWorker] Fatal error:', err)
  process.exit(1)
})
