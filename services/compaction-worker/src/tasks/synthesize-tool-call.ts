/**
 * synthesize-tool-call task — fill empty content on assistant tool-call messages.
 *
 * Replaces the setInterval-driven drainToolSynthQueue() loop in the legacy JS
 * compactor. Each empty tool-call message becomes its own job, dedup'd by
 * job_key=messageId so re-enqueues are idempotent.
 *
 * graphile-worker handles retry/backoff/max_attempts at the runner level.
 * After max_attempts, the job remains in graphile_worker._private_jobs with
 * locked_at=NULL and attempts=max_attempts; operators can re-enqueue if needed.
 */

import type { Task } from 'graphile-worker'
import { synthesizeToolCallContent } from '@rivetos/memory-postgres'
import { config } from '../config.js'

export interface SynthesizeToolCallPayload {
  messageId: string
}

interface MessageRow {
  id: string
  tool_name: string | null
  tool_args: string | object | null
  agent: string | null
  created_at: Date
  content: string | null
}

export const synthesizeToolCallTask: Task = async (payload, helpers) => {
  const { messageId } = payload as SynthesizeToolCallPayload

  await helpers.withPgClient(async (client) => {
    const result = await client.query<MessageRow>(
      `SELECT id, tool_name, tool_args, agent, created_at, content
         FROM ros_messages
        WHERE id = $1`,
      [messageId],
    )

    if (result.rows.length === 0) {
      helpers.logger.warn(
        `[synthesize-tool-call] message ${messageId.slice(0, 8)} not found — dropping job`,
      )
      return
    }

    const row = result.rows[0]

    // Skip if content already exists (raced with another writer or already synthesized)
    if (row.content && row.content.trim().length > 0) {
      helpers.logger.info(
        `[synthesize-tool-call] message ${messageId.slice(0, 8)} already has content — skipping`,
      )
      return
    }

    if (!row.tool_name) {
      helpers.logger.warn(
        `[synthesize-tool-call] message ${messageId.slice(0, 8)} has no tool_name — dropping job`,
      )
      return
    }

    const toolArgs =
      typeof row.tool_args === 'string' ? JSON.parse(row.tool_args || '{}') : (row.tool_args ?? {})

    const synth = await synthesizeToolCallContent({
      endpoint: config.toolSynthEndpoint,
      model: config.toolSynthModel,
      apiKey: config.llmApiKey,
      toolName: row.tool_name,
      toolArgs,
    })

    if (!synth || synth.trim().length === 0) {
      // Throw so graphile-worker retries with backoff (max_attempts in trigger config).
      throw new Error('Empty synth response')
    }

    await client.query(`UPDATE ros_messages SET content = $1 WHERE id = $2`, [synth, messageId])
    helpers.logger.info(`[synthesize-tool-call] ${row.tool_name} → ${synth.slice(0, 80)}`)
  })
}
