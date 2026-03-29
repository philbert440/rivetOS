/**
 * Logger — structured, level-gated logging for RivetOS.
 *
 * Levels: error, warn, info, debug
 * Default level from RIVETOS_LOG_LEVEL env var (default: 'info').
 * Format: [RivetOS] [LEVEL] [component] message
 *
 * Usage:
 *   import { logger } from './logger.js';
 *   const log = logger('Router');
 *   log.info('Registered agent', agentId);
 *   log.debug('Route details', { agent, provider });
 *   log.error('Failed to route', err);
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let currentLevel: LogLevel = (process.env.RIVETOS_LOG_LEVEL as LogLevel) ?? 'info';

if (!LEVEL_PRIORITY.hasOwnProperty(currentLevel)) {
  currentLevel = 'info';
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel];
}

function formatMessage(level: LogLevel, component: string, message: string): string {
  return `[RivetOS] [${level.toUpperCase()}] [${component}] ${message}`;
}

/**
 * Create a logger scoped to a component.
 */
export function logger(component: string): Logger {
  return {
    error(message: string, ...args: unknown[]): void {
      if (shouldLog('error')) {
        console.error(formatMessage('error', component, message), ...args);
      }
    },
    warn(message: string, ...args: unknown[]): void {
      if (shouldLog('warn')) {
        console.warn(formatMessage('warn', component, message), ...args);
      }
    },
    info(message: string, ...args: unknown[]): void {
      if (shouldLog('info')) {
        console.log(formatMessage('info', component, message), ...args);
      }
    },
    debug(message: string, ...args: unknown[]): void {
      if (shouldLog('debug')) {
        console.log(formatMessage('debug', component, message), ...args);
      }
    },
  };
}
