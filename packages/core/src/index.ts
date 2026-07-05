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

// Stream collection (AsyncIterable<LLMChunk> → StreamEvents)
export { collectLlmStream } from './domain/aisdk-stream.js'
export type { StreamCollectorResult } from './domain/aisdk-stream.js'

export { Router } from './domain/router.js'
export type { RouteResult } from './domain/router.js'
export { WorkspaceLoader } from './domain/workspace.js'
export { MessageQueue, isCommand, parseCommand } from './domain/queue.js'
export { SILENT_RESPONSES } from './domain/constants.js'
export { DelegationEngine, filterToolsForAgent, deduplicateTools } from './domain/delegation.js'
export { noopDelegationRecorder, createPgDelegationRecorder } from './domain/delegation-recorder.js'
export type { DelegationRunsRecorder } from './domain/delegation-recorder.js'
export { createHeartbeatScheduler, scheduleToCronMatch } from './domain/heartbeat-scheduler.js'
export { SubagentManagerImpl, createSubagentTools } from './domain/subagent.js'
export type { SubagentManagerConfig } from './domain/subagent.js'
export { InMemorySubagentStore, PgSubagentStore } from './domain/subagent-store.js'
export type {
  SubagentStore,
  NewSessionInput,
  TurnResult as SubagentTurnResult,
  ClaimedSession,
} from './domain/subagent-store.js'
export { createSubagentExecutor, createSubagentWorker } from './domain/subagent-worker.js'
export type {
  SubagentExecutor,
  SubagentExecutorConfig,
  SubagentWorker,
  SubagentWorkerOptions,
} from './domain/subagent-worker.js'
export { InMemoryTaskStore, PgTaskStore, TASK_JOB_NAME, taskJobKey } from './domain/task/store.js'
export type {
  TaskStore,
  TaskRow,
  NewTaskInput,
  TaskListFilter,
  PgTaskStoreOptions,
} from './domain/task/store.js'
export { createChatLoopExecutor } from './domain/task/chat-loop-executor.js'
export type { ChatLoopExecutorConfig } from './domain/task/chat-loop-executor.js'
export {
  createExecutorRegistry,
  createTaskHandler,
  createTaskRunner,
} from './domain/task/runner.js'
export type {
  TaskExecutorRegistry,
  TaskHandlerOptions,
  TaskRunner,
  TaskRunnerOptions,
} from './domain/task/runner.js'
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
export { AgentChannelServer, loadTlsConfig } from './runtime/agent-channel.js'
export type { AgentChannelTlsConfig } from './runtime/agent-channel.js'
export type { AgentChannelConfig } from './runtime/agent-channel.js'

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
