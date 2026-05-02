/**
 * Heartbeat — scheduled agent execution.
 *
 * Runs agents on a schedule (interval or cron). Each heartbeat creates
 * a turn with the configured prompt, sends the response to the
 * configured output channel (or swallows it if silent).
 *
 * Respects quiet hours — no heartbeats during sleep time.
 */

import type { HeartbeatConfig } from '@rivetos/types'
import { logger } from '../logger.js'
import { parseCron, nextCronFiring, type CronSchedule } from './cron.js'

const log = logger('Heartbeat')

export interface HeartbeatRunner {
  start(): void
  stop(): void
}

export interface HeartbeatHandler {
  (config: HeartbeatConfig): Promise<void>
}

type ParsedSchedule =
  | { kind: 'interval'; ms: number }
  | { kind: 'cron'; cron: CronSchedule; expr: string }

/**
 * Parse a schedule into either an interval (ms) or a cron specification.
 * Supports:
 *   - Number: interval in minutes
 *   - "30s" / "30m" / "1h": interval with unit
 *   - "0 8,20 * * *": standard 5-field cron
 */
export function parseSchedule(schedule: string | number): ParsedSchedule {
  if (typeof schedule === 'number') {
    return { kind: 'interval', ms: schedule * 60_000 }
  }

  const intervalMatch = /^(\d+)(s|sec|m|min|h|hr)?$/i.exec(schedule)
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- optional regex group
    const unit = (intervalMatch[2] ?? 'm').toLowerCase()
    const ms =
      unit === 's' || unit === 'sec'
        ? value * 1000
        : unit === 'h' || unit === 'hr'
          ? value * 3_600_000
          : value * 60_000
    return { kind: 'interval', ms }
  }

  try {
    return { kind: 'cron', cron: parseCron(schedule), expr: schedule }
  } catch (err: unknown) {
    log.warn(
      `Unknown schedule format: "${schedule}" (${(err as Error).message}), defaulting to 30 min`,
    )
    return { kind: 'interval', ms: 30 * 60_000 }
  }
}

/**
 * Check if current time is within quiet hours.
 */
function isQuietHours(quiet?: { start: number; end: number }): boolean {
  if (!quiet) return false

  const hour = new Date().getHours()

  if (quiet.start < quiet.end) {
    return hour >= quiet.start && hour < quiet.end
  } else {
    return hour >= quiet.start || hour < quiet.end
  }
}

export function createHeartbeatRunner(
  configs: HeartbeatConfig[],
  handler: HeartbeatHandler,
): HeartbeatRunner {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let stopped = false

  return {
    start() {
      stopped = false
      for (const config of configs) {
        const schedule = parseSchedule(config.schedule)
        const name = `${config.agent}/${config.outputChannel ?? 'silent'}`

        if (schedule.kind === 'interval') {
          log.info(`Scheduling "${name}" every ${Math.round(schedule.ms / 60000)} min`)

          const initialDelay = setTimeout(() => {
            void runHeartbeat(config, handler)
          }, 10_000)
          timers.add(initialDelay)

          const timer = setInterval(() => {
            void runHeartbeat(config, handler)
          }, schedule.ms)
          timers.add(timer as unknown as ReturnType<typeof setTimeout>)
        } else {
          log.info(`Scheduling "${name}" on cron "${schedule.expr}"`)
          const scheduleNext = (): void => {
            if (stopped) return
            const next = nextCronFiring(schedule.cron, new Date())
            const delay = Math.max(1000, next.getTime() - Date.now())
            const t = setTimeout(() => {
              timers.delete(t)
              void runHeartbeat(config, handler).finally(scheduleNext)
            }, delay)
            timers.add(t)
          }
          scheduleNext()
        }
      }
    },

    stop() {
      stopped = true
      for (const timer of timers) {
        clearInterval(timer)
        clearTimeout(timer)
      }
      timers.clear()
      log.info('Stopped')
    },
  }
}

async function runHeartbeat(config: HeartbeatConfig, handler: HeartbeatHandler): Promise<void> {
  if (isQuietHours(config.quietHours)) {
    return
  }

  try {
    await handler(config)
  } catch (err: unknown) {
    log.error(`Error running ${config.agent}: ${(err as Error).message}`)
  }
}
