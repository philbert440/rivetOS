/**
 * Logger — structured, level-gated logging for RivetOS.
 *
 * Two modes:
 *   - Pretty (default, dev) — colored, human-readable: [RivetOS] [LEVEL] [component] message
 *   - JSON (production)     — one JSON object per line, machine-parseable
 *
 * Set via RIVETOS_LOG_FORMAT=json|pretty (default: pretty)
 * Level via RIVETOS_LOG_LEVEL=error|warn|info|debug (default: info)
 *
 * Usage:
 *   import { logger } from './logger.js';
 *   const log = logger('Router');
 *   log.info('Registered agent', agentId);
 *   log.debug('Route details', { agent, provider });
 *   log.error('Failed to route', err);
 */

import type { RivetError } from '@rivetos/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogFormat = 'json' | 'pretty'

export interface LogEntry {
  level: LogLevel
  component: string
  message: string
  timestamp: string
  data?: Record<string, unknown>
  error?: {
    name: string
    message: string
    code?: string
    severity?: string
    stack?: string
  }
}

export interface Logger {
  error(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: '\x1b[31m', // red
  warn: '\x1b[33m', // yellow
  info: '\x1b[36m', // cyan
  debug: '\x1b[90m', // gray
}

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'

let currentLevel: LogLevel = 'info'
const rawLevel = process.env.RIVETOS_LOG_LEVEL
if (rawLevel && Object.hasOwn(LEVEL_PRIORITY, rawLevel)) {
  currentLevel = rawLevel as LogLevel
}

let currentFormat: LogFormat = 'pretty'
const rawFormat = process.env.RIVETOS_LOG_FORMAT
if (rawFormat === 'json' || rawFormat === 'pretty') {
  currentFormat = rawFormat
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
}

export function getLogLevel(): LogLevel {
  return currentLevel
}

export function setLogFormat(format: LogFormat): void {
  currentFormat = format
}

export function getLogFormat(): LogFormat {
  return currentFormat
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel]
}

function extractErrorInfo(args: unknown[]): {
  data?: Record<string, unknown>
  error?: LogEntry['error']
} {
  const result: { data?: Record<string, unknown>; error?: LogEntry['error'] } = {}

  for (const arg of args) {
    if (arg instanceof Error) {
      const errInfo: LogEntry['error'] = {
        name: arg.name,
        message: arg.message,
        stack: arg.stack,
      }
      // Check for RivetError properties
      const rivetErr = arg as Partial<RivetError>
      if (rivetErr.code) errInfo.code = rivetErr.code
      if (rivetErr.severity) errInfo.severity = rivetErr.severity
      result.error = errInfo
    } else if (typeof arg === 'object' && arg !== null) {
      result.data = { ...result.data, ...(arg as Record<string, unknown>) }
    }
  }

  return result
}

function formatPretty(level: LogLevel, component: string, message: string, args: unknown[]): void {
  const color = LEVEL_COLORS[level]
  const ts = new Date().toISOString().slice(11, 23) // HH:mm:ss.SSS
  const prefix = `${DIM}${ts}${RESET} ${color}${level.toUpperCase().padEnd(5)}${RESET} ${DIM}[${component}]${RESET}`

  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(`${prefix} ${message}`, ...args)
}

function formatJSON(level: LogLevel, component: string, message: string, args: unknown[]): void {
  const { data, error } = extractErrorInfo(args)

  const entry: LogEntry = {
    level,
    component,
    message,
    timestamp: new Date().toISOString(),
    ...(data ? { data } : {}),
    ...(error ? { error } : {}),
  }

  // Non-Error, non-object args get appended as extra data
  const extras: unknown[] = args.filter(
    (a) => !(a instanceof Error) && (typeof a !== 'object' || a === null),
  )
  if (extras.length > 0) {
    entry.data = { ...entry.data, extra: extras.length === 1 ? extras[0] : extras }
  }

  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(JSON.stringify(entry))
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a logger scoped to a component.
 */
export function logger(component: string): Logger {
  return {
    error(message: string, ...args: unknown[]): void {
      if (!shouldLog('error')) return
      if (currentFormat === 'json') {
        formatJSON('error', component, message, args)
      } else {
        formatPretty('error', component, message, args)
      }
    },
    warn(message: string, ...args: unknown[]): void {
      if (!shouldLog('warn')) return
      if (currentFormat === 'json') {
        formatJSON('warn', component, message, args)
      } else {
        formatPretty('warn', component, message, args)
      }
    },
    info(message: string, ...args: unknown[]): void {
      if (!shouldLog('info')) return
      if (currentFormat === 'json') {
        formatJSON('info', component, message, args)
      } else {
        formatPretty('info', component, message, args)
      }
    },
    debug(message: string, ...args: unknown[]): void {
      if (!shouldLog('debug')) return
      if (currentFormat === 'json') {
        formatJSON('debug', component, message, args)
      } else {
        formatPretty('debug', component, message, args)
      }
    },
  }
}
