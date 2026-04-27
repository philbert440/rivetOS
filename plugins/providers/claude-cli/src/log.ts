/**
 * Zero-dependency logger for the claude-cli provider (and embedded MCP bridge).
 * Respects RIVETOS_LOG_LEVEL (error|warn|info|debug, default: info).
 * Never imports from @rivetos/core — matches the existing provider pattern.
 *
 * Format: [HH:mm:ss.SSS] LEVEL [component] message [meta-json-if-present]
 * Outputs via console.error (warn/error) or console.log (info/debug).
 */

export interface BridgeLogger {
  error(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  debug(msg: string, meta?: Record<string, unknown>): void
}

const LEVEL_PRIORITY: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

function getLogLevel(): number {
  const raw = process.env.RIVETOS_LOG_LEVEL?.toLowerCase().trim()
  if (!raw) return LEVEL_PRIORITY.info
  const prio = LEVEL_PRIORITY[raw]
  return typeof prio === 'number' ? prio : LEVEL_PRIORITY.info
}

const CURRENT_LEVEL = getLogLevel()

function formatTimestamp(): string {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `${h}:${m}:${s}.${ms}`
}

function shouldLog(level: number): boolean {
  return level <= CURRENT_LEVEL
}

function logAtLevel(
  levelName: string,
  levelPrio: number,
  component: string,
  msg: string,
  meta?: Record<string, unknown>,
) {
  if (!shouldLog(levelPrio)) return

  const ts = formatTimestamp()
  let line = `[${ts}] ${levelName.toUpperCase()} [${component}] ${msg}`

  if (meta && Object.keys(meta).length > 0) {
    line += ` ${JSON.stringify(meta)}`
  }

  if (levelPrio <= LEVEL_PRIORITY.warn) {
    console.error(line)
  } else {
    console.log(line)
  }
}

export function createLogger(component: string): BridgeLogger {
  return {
    error: (msg, meta) => logAtLevel('error', 0, component, msg, meta),
    warn: (msg, meta) => logAtLevel('warn', 1, component, msg, meta),
    info: (msg, meta) => logAtLevel('info', 2, component, msg, meta),
    debug: (msg, meta) => logAtLevel('debug', 3, component, msg, meta),
  }
}
