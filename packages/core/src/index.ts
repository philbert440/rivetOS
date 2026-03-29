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
export { SubagentManagerImpl, createSubagentTools } from './domain/subagent.js';
export { SkillManagerImpl, createSkillListTool } from './domain/skills.js';

// Logger
export { logger, setLogLevel, getLogLevel } from './logger.js';
export type { Logger, LogLevel } from './logger.js';

// Application — decomposed runtime
export { Runtime } from './runtime/runtime.js';
export type { RuntimeConfig } from './runtime/runtime.js';
export { CommandHandler } from './runtime/commands.js';
export type { CommandDeps } from './runtime/commands.js';
export { StreamManager } from './runtime/streaming.js';
export type { SessionStreamState } from './runtime/streaming.js';
export { SessionManager } from './runtime/sessions.js';
