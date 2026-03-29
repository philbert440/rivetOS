/**
 * Heartbeat — scheduled agent execution.
 *
 * Runs agents on a schedule (interval or cron). Each heartbeat creates
 * a turn with the configured prompt, sends the response to the
 * configured output channel (or swallows it if silent).
 *
 * Respects quiet hours — no heartbeats during sleep time.
 */

import type { HeartbeatConfig } from '@rivetos/types';

export interface HeartbeatRunner {
  start(): void;
  stop(): void;
}

export interface HeartbeatHandler {
  (config: HeartbeatConfig): Promise<void>;
}

/**
 * Parse a cron-like schedule into an interval in ms.
 * Supports:
 *   - Number: interval in minutes (e.g., 30 → every 30 min)
 *   - String with unit: "30m", "1h", "6h"
 *   - Simple cron not supported yet — use interval
 */
function parseSchedule(schedule: string | number): number {
  if (typeof schedule === 'number') {
    return schedule * 60 * 1000; // minutes → ms
  }

  const match = schedule.match(/^(\d+)(m|min|h|hr|s|sec)?$/i);
  if (!match) {
    console.warn(`[Heartbeat] Unknown schedule format: "${schedule}", defaulting to 30 min`);
    return 30 * 60 * 1000;
  }

  const value = parseInt(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase();

  switch (unit) {
    case 's':
    case 'sec':
      return value * 1000;
    case 'm':
    case 'min':
      return value * 60 * 1000;
    case 'h':
    case 'hr':
      return value * 60 * 60 * 1000;
    default:
      return value * 60 * 1000;
  }
}

/**
 * Check if current time is within quiet hours.
 */
function isQuietHours(quiet?: { start: number; end: number }): boolean {
  if (!quiet) return false;

  const now = new Date();
  const hour = now.getHours();

  if (quiet.start <= quiet.end) {
    // e.g., 23-7 wraps around midnight
    return hour >= quiet.start || hour < quiet.end;
  } else {
    // e.g., 9-17 (normal range)
    return hour >= quiet.start && hour < quiet.end;
  }
}

/**
 * Create a heartbeat runner for a set of heartbeat configs.
 */
export function createHeartbeatRunner(
  configs: HeartbeatConfig[],
  handler: HeartbeatHandler,
): HeartbeatRunner {
  const timers: ReturnType<typeof setInterval>[] = [];

  return {
    start() {
      for (const config of configs) {
        const intervalMs = parseSchedule(config.schedule);
        const name = `${config.agent}/${config.outputChannel ?? 'silent'}`;

        console.log(`[Heartbeat] Scheduling "${name}" every ${Math.round(intervalMs / 60000)} min`);

        // Run first heartbeat after a short delay (not immediately on startup)
        const initialDelay = setTimeout(async () => {
          await runHeartbeat(config, handler);
        }, 10000); // 10 sec delay on first run

        // Then on interval
        const timer = setInterval(async () => {
          await runHeartbeat(config, handler);
        }, intervalMs);

        timers.push(timer);
        // Store the initial delay timer too for cleanup
        timers.push(initialDelay as any);
      }
    },

    stop() {
      for (const timer of timers) {
        clearInterval(timer);
        clearTimeout(timer);
      }
      timers.length = 0;
      console.log('[Heartbeat] Stopped');
    },
  };
}

async function runHeartbeat(config: HeartbeatConfig, handler: HeartbeatHandler): Promise<void> {
  // Check quiet hours
  if (isQuietHours(config.quietHours)) {
    return;
  }

  try {
    await handler(config);
  } catch (err: any) {
    console.error(`[Heartbeat] Error running ${config.agent}: ${err.message}`);
  }
}
