/**
 * @rivetos/core — The agent runtime.
 *
 * Domain layer: pure business logic (no I/O, no platform specifics).
 * Application layer: wires domain + plugins.
 */

// Domain
export { AgentLoop } from './domain/loop.js';
export type { AgentLoopConfig, TurnResult } from './domain/loop.js';
export { Router } from './domain/router.js';
export type { RouteResult } from './domain/router.js';
export { WorkspaceLoader } from './domain/workspace.js';
export { MessageQueue, isCommand, parseCommand } from './domain/queue.js';
export { SILENT_RESPONSES } from './domain/constants.js';
export { DelegationEngine } from './domain/delegation.js';
export { createHeartbeatRunner } from './domain/heartbeat.js';

// Logger
export { logger, setLogLevel, getLogLevel } from './logger.js';
export type { Logger, LogLevel } from './logger.js';

// Application
export { Runtime } from './runtime.js';
export type { RuntimeConfig } from './runtime.js';
