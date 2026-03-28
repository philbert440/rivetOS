/**
 * @rivetos/core — The agent runtime.
 *
 * Domain layer: pure business logic (no I/O, no platform specifics).
 * Application layer: wires domain + plugins.
 */

// Domain
export { AgentLoop } from './domain/loop.js'
export type { AgentLoopConfig, TurnResult } from './domain/loop.js'
export { HookPipelineImpl } from './domain/hooks.js'
export type { HookLogger } from './domain/hooks.js'
export { createFallbackHook, createFallbackHookWithState } from './domain/fallback.js'
export {
  createSafetyHooks,
  createShellDangerHook,
  createWorkspaceFenceHook,
  createAuditHooks,
  createCustomRulesHook,
  RULE_NPM_DRY_RUN,
  RULE_WARN_CONFIG_WRITE,
  RULE_NO_DELETE_GIT,
} from './domain/safety-hooks.js'
export type {
  SafetyRule,
  AuditEntry,
  AuditWriter,
  SafetyHooksConfig,
  WorkspaceFenceConfig,
} from './domain/safety-hooks.js'
export {
  createAutoActionHooks,
  createAutoFormatHook,
  createAutoLintHook,
  createAutoTestHook,
  createAutoGitCheckHook,
  createCustomActionHook,
} from './domain/auto-actions.js'
export type { ShellExecutor, AutoAction, AutoActionsConfig } from './domain/auto-actions.js'
export {
  createSessionHooks,
  createSessionStartHook,
  createSessionSummaryHook,
  createAutoCommitHook,
  createPreCompactHook,
  createPostCompactHook,
} from './domain/session-hooks.js'
export type { SessionHooksConfig, SessionHooksContext } from './domain/session-hooks.js'

export { Router } from './domain/router.js'
export type { RouteResult } from './domain/router.js'
export { WorkspaceLoader } from './domain/workspace.js'
export { MessageQueue, isCommand, parseCommand } from './domain/queue.js'
export { SILENT_RESPONSES } from './domain/constants.js'
export { DelegationEngine, filterToolsForAgent } from './domain/delegation.js'
export { createHeartbeatRunner } from './domain/heartbeat.js'
export { SubagentManagerImpl, createSubagentTools } from './domain/subagent.js'
export {
  SkillManagerImpl,
  createSkillListTool,
  createSkillManageTool,
  scanSkillContent,
  cosineSimilarity,
} from './domain/skills/index.js'
export type { SkillManageToolOptions } from './domain/skills/index.js'

// Logger
export { logger, setLogLevel, getLogLevel, setLogFormat, getLogFormat } from './logger.js'
export type { Logger, LogLevel, LogFormat, LogEntry } from './logger.js'

// Reliability
export {
  CircuitBreaker,
  getCircuitBreaker,
  getAllCircuitBreakerStats,
  resetAllCircuitBreakers,
} from './domain/circuit-breaker.js'
export type {
  CircuitState,
  CircuitBreakerConfig,
  CircuitBreakerStats,
} from './domain/circuit-breaker.js'
export { ReconnectionManager } from './domain/reconnect.js'
export type { ReconnectConfig } from './domain/reconnect.js'

// Application — decomposed runtime
export { Runtime } from './runtime/runtime.js'
export type { RuntimeConfig } from './runtime/runtime.js'
export { CommandHandler } from './runtime/commands.js'
export type { CommandDeps } from './runtime/commands.js'
export { StreamManager } from './runtime/streaming.js'
export type { SessionStreamState } from './runtime/streaming.js'
export { SessionManager } from './runtime/sessions.js'
export { TurnHandler } from './runtime/turn-handler.js'
export type { TurnHandlerDeps } from './runtime/turn-handler.js'
export { resolveAttachments, buildHistoryContent } from './runtime/media.js'
export type { MediaResult } from './runtime/media.js'

// Observability
export { metrics } from './runtime/metrics.js'
export type { TurnMetric, MetricsSnapshot } from './runtime/metrics.js'
export { HealthServer } from './runtime/health.js'
export type { HealthStatus, HealthConfig } from './runtime/health.js'

// Mesh
export { FileMeshRegistry, buildLocalNode } from './domain/mesh.js'
export type { MeshRegistryConfig, BuildLocalNodeArgs } from './domain/mesh.js'
export { MeshDelegationEngine } from './domain/mesh-delegation.js'
export type { MeshDelegationConfig } from './domain/mesh-delegation.js'

// Security
export {
  redactSecrets,
  ensureEnvPermissions,
  validateNoSecretsInConfig,
  getSecretEnvVars,
  resolveOpReferences,
} from './security/secrets.js'
export { rotateAuditLogs } from './security/audit-rotation.js'
export type { AuditRotationConfig, RotationResult } from './security/audit-rotation.js'
