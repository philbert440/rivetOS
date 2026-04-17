/**
 * Embedding Worker — Event-driven, runs on Datahub (CT110).
 *
 * Listens for Postgres NOTIFY on 'embedding_work' channel.
 * Picks up queue entries from ros_embedding_queue.
 * Calls Nemotron-8B on GERTY GPU (port 9401) for embeddings.
 * Writes vectors back to source rows, removes queue entries.
 *
 * Single instance — no timers, no polling, no races.
 */

import pg from 'pg'

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const PG_URL = process.env.RIVETOS_PG_URL
if (!PG_URL) {
  console.error('[EmbedWorker] RIVETOS_PG_URL is required')
  process.exit(1)
}

const EMBED_URL = process.env.RIVETOS_EMBED_URL
if (!EMBED_URL) { console.error('RIVETOS_EMBED_URL is required'); process.exit(1) }
const EMBED_MODEL = process.env.RIVETOS_EMBED_MODEL ?? 'nemotron'
const BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE ?? '50', 10)
const API_BATCH_SIZE = parseInt(process.env.EMBED_API_BATCH_SIZE ?? '8', 10)
const MAX_RETRIES = parseInt(process.env.EMBED_MAX_RETRIES ?? '3', 10)
const MAX_FAILURES = parseInt(process.env.EMBED_MAX_FAILURES ?? '3', 10)
const TRUNCATE_DIMS = parseInt(process.env.EMBED_TRUNCATE_DIMS ?? '4000', 10)
const API_TIMEOUT_MS = parseInt(process.env.EMBED_API_TIMEOUT_MS ?? '30000', 10)
const MAX_CONTENT_LENGTH = 8000

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let processing = false
let drainRequested = false
const metrics = {
  totalEmbedded: 0,
  totalFailed: 0,
  totalApiCalls: 0,
  avgLatencyMs: 0,
  _latencySum: 0,
  _latencyCount: 0,
}

// ---------------------------------------------------------------------------
// Pool for worker queries (shared across processing)
// ---------------------------------------------------------------------------

const pool = new pg.Pool({ connectionString: PG_URL, max: 4 })

pool.on('error', (err) => {
  console.error('[EmbedWorker] Pool error:', err.message)
})

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
    console.error('[EmbedWorker] Listener connection error:', err.message)
    scheduleReconnect()
  })

  try {
    await client.connect()
    await client.query('LISTEN embedding_work')
    console.log('[EmbedWorker] Listening on channel: embedding_work')
    reconnectDelay = 5_000 // reset on success

    client.on('notification', (_msg) => {
      // Don't process inline — just flag that work is available
      // This avoids blocking the notification handler
      if (!processing) {
        void processQueue()
      } else {
        drainRequested = true
      }
    })
  } catch (err) {
    console.error('[EmbedWorker] Failed to connect listener:', err.message)
    scheduleReconnect()
    return null
  }

  return client
}

function scheduleReconnect() {
  console.log(`[EmbedWorker] Reconnecting listener in ${reconnectDelay / 1000}s...`)
  setTimeout(() => {
    startListener().catch((e) =>
      console.error('[EmbedWorker] Reconnect failed:', e.message),
    )
  }, reconnectDelay)
  // Exponential backoff capped at MAX_RECONNECT_DELAY
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

// ---------------------------------------------------------------------------
// Process queue — pick up all pending items and embed them
// ---------------------------------------------------------------------------

async function processQueue() {
  if (processing) return
  processing = true

  try {
    // Keep draining until nothing left
    let processed = 0
    do {
      drainRequested = false
      const batch = await fetchBatch()
      if (batch.length === 0) break

      processed += await processBatch(batch)
    } while (drainRequested || (await hasMoreWork()))

    if (processed > 0) {
      console.log(
        `[EmbedWorker] Cycle done: ${processed} embedded (total: ${metrics.totalEmbedded}, failed: ${metrics.totalFailed}, avg ${metrics.avgLatencyMs}ms)`,
      )
    }
  } catch (err) {
    console.error('[EmbedWorker] processQueue error:', err.message)
  } finally {
    processing = false

    // If more notifications came in while we were processing, drain again
    if (drainRequested) {
      drainRequested = false
      void processQueue()
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch a batch of queue entries
// ---------------------------------------------------------------------------

async function fetchBatch() {
  const result = await pool.query(
    `SELECT q.id, q.target_table, q.target_id
     FROM ros_embedding_queue q
     WHERE q.attempts < $1
     ORDER BY q.created_at ASC
     LIMIT $2`,
    [MAX_FAILURES, BATCH_SIZE],
  )
  return result.rows
}

async function hasMoreWork() {
  const result = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM ros_embedding_queue WHERE attempts < $1) AS has_work`,
    [MAX_FAILURES],
  )
  return result.rows[0]?.has_work === true
}

// ---------------------------------------------------------------------------
// Process a batch of queue entries
// ---------------------------------------------------------------------------

async function processBatch(queueRows) {
  let embedded = 0

  // Group by table for efficient processing
  const byTable = new Map()
  for (const row of queueRows) {
    if (!byTable.has(row.target_table)) byTable.set(row.target_table, [])
    byTable.get(row.target_table).push(row)
  }

  for (const [table, rows] of byTable) {
    const targetIds = rows.map((r) => r.target_id)

    // Fetch actual content from the source table
    const content = await pool.query(
      `SELECT id, content FROM ${table}
       WHERE id = ANY($1::uuid[])
         AND content IS NOT NULL
         AND LENGTH(content) > 0`,
      [targetIds],
    )

    if (content.rows.length === 0) {
      // Content was deleted or too short — remove from queue
      const queueIds = rows.map((r) => r.id)
      await pool.query(
        `DELETE FROM ros_embedding_queue WHERE id = ANY($1::bigint[])`,
        [queueIds],
      )
      continue
    }

    // Map content rows by id for lookup
    const contentMap = new Map(content.rows.map((r) => [r.id, r.content]))

    // Process in API-sized batches
    for (let i = 0; i < rows.length; i += API_BATCH_SIZE) {
      const chunk = rows.slice(i, i + API_BATCH_SIZE)
      const textsAndIds = chunk
        .filter((r) => contentMap.has(r.target_id))
        .map((r) => ({
          queueId: r.id,
          targetId: r.target_id,
          text: contentMap.get(r.target_id).slice(0, MAX_CONTENT_LENGTH),
        }))

      if (textsAndIds.length === 0) continue

      const apiStart = Date.now()
      const vectors = await embedBatch(textsAndIds.map((t) => t.text))
      const apiDuration = Date.now() - apiStart

      // Track metrics
      metrics._latencySum += apiDuration
      metrics._latencyCount++
      metrics.avgLatencyMs = Math.round(metrics._latencySum / metrics._latencyCount)
      metrics.totalApiCalls++

      // Write results
      for (let j = 0; j < textsAndIds.length; j++) {
        const { queueId, targetId } = textsAndIds[j]
        const vec = vectors[j]

        if (vec) {
          try {
            const truncated =
              vec.length > TRUNCATE_DIMS ? vec.slice(0, TRUNCATE_DIMS) : vec
            await pool.query(
              `UPDATE ${table} SET embedding = $1 WHERE id = $2`,
              [`[${truncated.join(',')}]`, targetId],
            )
            // Remove from queue on success
            await pool.query(
              `DELETE FROM ros_embedding_queue WHERE id = $1`,
              [queueId],
            )
            embedded++
            metrics.totalEmbedded++
          } catch (err) {
            console.error(
              `[EmbedWorker] Failed to store ${table} ${targetId}: ${err.message}`,
            )
            await markQueueFailure(queueId, err.message)
            metrics.totalFailed++
          }
        } else {
          await markQueueFailure(queueId, 'Embedding returned null after retries')
          // Also mark on source table
          await markSourceFailure(table, targetId, 'Embedding returned null after retries')
          metrics.totalFailed++
        }
      }
    }
  }

  return embedded
}

// ---------------------------------------------------------------------------
// Batch embed with retry
// ---------------------------------------------------------------------------

async function embedBatch(texts) {
  let lastError = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${EMBED_URL}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts, model: EMBED_MODEL }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })

      // Non-transient error (4xx)
      if (!response.ok && response.status < 500) {
        console.error(
          `[EmbedWorker] API returned ${response.status}: ${response.statusText} (not retrying)`,
        )
        return texts.map(() => null)
      }

      // Transient error (5xx)
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`)
        if (attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt) * 1000
          console.error(
            `[EmbedWorker] API ${response.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`,
          )
          await sleep(delay)
          continue
        }
        break
      }

      const data = await response.json()
      if (!data.data) return texts.map(() => null)

      // Map response items back by index
      const results = texts.map(() => null)
      for (const item of data.data) {
        const idx = item.index ?? 0
        if (idx >= 0 && idx < results.length && item.embedding) {
          results[idx] = item.embedding
        }
      }

      return results
    } catch (err) {
      lastError = err

      if (isTransientError(err) && attempt < MAX_RETRIES) {
        const delay = Math.pow(2, attempt) * 1000
        console.error(
          `[EmbedWorker] Transient error: ${err.message}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`,
        )
        await sleep(delay)
        continue
      }

      break
    }
  }

  console.error(
    `[EmbedWorker] Batch embed failed after ${MAX_RETRIES} retries: ${lastError?.message}`,
  )
  return texts.map(() => null)
}

// ---------------------------------------------------------------------------
// Failure tracking
// ---------------------------------------------------------------------------

async function markQueueFailure(queueId, errorMsg) {
  try {
    await pool.query(
      `UPDATE ros_embedding_queue
       SET attempts = attempts + 1, last_error = $1
       WHERE id = $2`,
      [errorMsg, queueId],
    )
  } catch (err) {
    console.error(`[EmbedWorker] Failed to mark queue failure ${queueId}: ${err.message}`)
  }
}

async function markSourceFailure(table, targetId, errorMsg) {
  try {
    await pool.query(
      `UPDATE ${table}
       SET embed_failures = COALESCE(embed_failures, 0) + 1,
           embed_error = $1
       WHERE id = $2`,
      [errorMsg, targetId],
    )
  } catch (err) {
    console.error(
      `[EmbedWorker] Failed to mark source failure ${table} ${targetId}: ${err.message}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTransientError(error) {
  if (error instanceof TypeError) return true // network errors
  if (error instanceof DOMException && error.name === 'AbortError') return true
  if (error instanceof Error && error.name === 'AbortError') return true
  return false
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  console.log('[EmbedWorker] Starting...')
  console.log(`[EmbedWorker] Embed endpoint: ${EMBED_URL}`)
  console.log(`[EmbedWorker] Batch: ${BATCH_SIZE}, API batch: ${API_BATCH_SIZE}, truncate: ${TRUNCATE_DIMS}`)

  // Start listener
  await startListener()

  // Process any existing queue entries on startup
  await processQueue()

  console.log('[EmbedWorker] Ready — waiting for notifications')

  // Periodic safety net: check for stranded queue entries every 5 minutes
  // (in case a NOTIFY was missed during a reconnection)
  setInterval(() => {
    if (!processing) {
      void processQueue()
    }
  }, 5 * 60 * 1000)
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[EmbedWorker] SIGTERM received, shutting down...')
  await pool.end()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('[EmbedWorker] SIGINT received, shutting down...')
  await pool.end()
  process.exit(0)
})

main().catch((err) => {
  console.error('[EmbedWorker] Fatal error:', err)
  process.exit(1)
})
