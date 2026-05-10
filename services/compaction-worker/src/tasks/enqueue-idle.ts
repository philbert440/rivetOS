/**
 * enqueue-idle task — cron-driven (every 5 min).
 *
 * Finds conversations idle for N minutes with at least M unsummarized
 * messages, and enqueues a compact-conversation job for each.
 *
 * Filled in step 9b.2.
 */

import type { Task } from 'graphile-worker'

export const enqueueIdleTask: Task = async (_payload, helpers) => {
  helpers.logger.info('[enqueue-idle] stub — implemented in 9b.2')
}
