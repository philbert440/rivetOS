/**
 * Heartbeat scheduler — graphile-worker driven.
 *
 * Replaces the previous in-process setTimeout/setInterval scheduler
 * + bespoke 5-field cron parser. Uses graphile-worker crontab so
 * heartbeats live on the same Postgres substrate as the rest of the
 * Workflow SDK queue infrastructure.
 *
 * Heartbeat schedules accepted:
 *   - 5-field cron expression (passed through, e.g. "0 8,20 * * *")
 *   - Number: interval in minutes (e.g. 30)
 *   - String interval: "30s" | "5m" | "1h" (sub-minute rounds up to 1 min)
 *
 * Each heartbeat is registered as a crontab item with a unique identifier;
 * the body checks quiet hours then invokes the supplied handler.
 */

import { parseCronItems, run, type Runner, type CronItem } from 'graphile-worker'
import type { HeartbeatConfig } from '@rivetos/types'
import { logger } from '../logger.js'

const log = logger('Heartbeat')

const TASK_NAME = 'rivetos-heartbeat'

export interface HeartbeatScheduler {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface HeartbeatHandler {
  (config: HeartbeatConfig): Promise<void>
}

export interface HeartbeatSchedulerOptions {
  pgUrl: string
  configs: HeartbeatConfig[]
  handler: HeartbeatHandler
}

interface CronMatchResult {
  match: string
  warning?: string
}

/**
 * Convert a HeartbeatConfig.schedule value into a graphile-worker crontab `match`.
 * Throws on unrecognized formats.
 */
export function scheduleToCronMatch(schedule: string | number): CronMatchResult {
  if (typeof schedule === 'number') {
    return intervalMinutesToMatch(schedule)
  }

  const intervalMatch = /^(\d+)(s|sec|m|min|h|hr)?$/i.exec(schedule)
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- optional regex group
    const unit = (intervalMatch[2] ?? 'm').toLowerCase()
    if (unit === 's' || unit === 'sec') {
      const mins = Math.max(1, Math.ceil(value / 60))
      return {
        match: `*/${mins} * * * *`,
        warning: `sub-minute heartbeat schedule "${schedule}" rounded up to ${mins}min — graphile-worker crontab is minute-granularity`,
      }
    }
    if (unit === 'h' || unit === 'hr') {
      return intervalMinutesToMatch(value * 60)
    }
    return intervalMinutesToMatch(value)
  }

  if (schedule.trim().split(/\s+/).length === 5) {
    return { match: schedule.trim() }
  }

  throw new Error(`Unrecognized heartbeat schedule: "${schedule}"`)
}

function intervalMinutesToMatch(mins: number): CronMatchResult {
  if (!Number.isFinite(mins) || mins < 1) {
    throw new Error(`Heartbeat interval must be at least 1 minute (got ${mins})`)
  }
  if (mins < 60) return { match: `*/${mins} * * * *` }
  if (mins % 60 === 0) {
    const hours = mins / 60
    if (hours < 24) return { match: `0 */${hours} * * *` }
  }
  return { match: `*/${mins} * * * *` }
}

function isQuietHours(quiet?: { start: number; end: number }): boolean {
  if (!quiet) return false
  const hour = new Date().getHours()
  if (quiet.start < quiet.end) return hour >= quiet.start && hour < quiet.end
  return hour >= quiet.start || hour < quiet.end
}

export function createHeartbeatScheduler(opts: HeartbeatSchedulerOptions): HeartbeatScheduler {
  let runner: Runner | undefined

  const items: CronItem[] = opts.configs.map((cfg, idx) => {
    const { match, warning } = scheduleToCronMatch(cfg.schedule)
    if (warning) log.warn(warning)
    return {
      task: TASK_NAME,
      match,
      identifier: `heartbeat-${cfg.agent}-${idx}`,
      payload: { configIndex: idx },
      options: { backfillPeriod: 0, maxAttempts: 1 },
    }
  })

  return {
    async start(): Promise<void> {
      if (items.length === 0) return
      log.info(
        `Scheduling ${items.length} heartbeat(s): ${opts.configs
          .map((c, i) => `${c.agent} (${String(items[i].match)})`)
          .join(', ')}`,
      )
      runner = await run({
        connectionString: opts.pgUrl,
        concurrency: Math.max(1, opts.configs.length),
        noHandleSignals: true,
        pollInterval: 60_000,
        taskList: {
          [TASK_NAME]: async (payload) => {
            const idx = (payload as { configIndex?: number } | null)?.configIndex
            if (typeof idx !== 'number' || idx < 0 || idx >= opts.configs.length) {
              log.warn(`Heartbeat fired with invalid configIndex: ${String(idx)}`)
              return
            }
            const cfg = opts.configs[idx]
            if (isQuietHours(cfg.quietHours)) return
            try {
              await opts.handler(cfg)
            } catch (err: unknown) {
              log.error(`Heartbeat ${cfg.agent} error: ${(err as Error).message}`)
            }
          },
        },
        parsedCronItems: parseCronItems(items),
      })
    },

    async stop(): Promise<void> {
      if (runner) {
        await runner.stop()
        runner = undefined
      }
      log.info('Stopped')
    },
  }
}
