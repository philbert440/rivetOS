/**
 * embed-target task — embed one row from ros_messages or ros_summaries.
 *
 * Job key (passed via add_job's job_key) is `embed-<table>-<id>` to dedupe
 * pending jobs for the same row.
 *
 * Filled in step 9b.3.
 */

import type { Task } from 'graphile-worker'

export interface EmbedTargetPayload {
  targetTable: 'ros_messages' | 'ros_summaries'
  targetId: string
}

export const embedTargetTask: Task = async (payload, helpers) => {
  const { targetTable, targetId } = payload as EmbedTargetPayload
  helpers.logger.info(`[embed-target] stub for ${targetTable}/${targetId.slice(0, 8)} — implemented in 9b.3`)
}
