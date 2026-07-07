/**
 * @rivetos/types — Shared interfaces for the RivetOS agent runtime.
 *
 * Interfaces only. Contract-scope dependencies only (@rivetos/den-protocol).
 * Every other package depends on this. Nothing else.
 */

export type { Message, ToolCall, ContentPart, TextPart, ImagePart, VideoPart } from './message.js'
export type {
  Provider,
  LLMResponse,
  LLMChunk,
  LLMUsage,
  ChatOptions,
  ThinkingLevel,
  ProviderErrorCode,
  ProviderSessionCapability,
  PreparedTurn,
} from './provider.js'
export { ProviderError } from './provider.js'
export type {
  ErrorSeverity,
  RivetErrorOptions,
  ChannelErrorCode,
  MemoryErrorCode,
  ConfigErrorCode,
  ToolErrorCode,
  DelegationErrorCode,
  RuntimeErrorCode,
} from './errors.js'
export {
  RivetError,
  ChannelError,
  MemoryError,
  ConfigError,
  ToolError,
  DelegationError,
  RuntimeError,
} from './errors.js'
export type {
  Channel,
  EditResult,
  InboundMessage,
  OutboundMessage,
  Attachment,
  ResolvedAttachment,
  Button,
  EmbedData,
} from './channel.js'
export type { Tool, ToolDefinition, ToolContext, ToolResult } from './tool.js'
export type { SessionContext } from './session-context.js'
export { buildLocalSessionContext, isSessionContext } from './session-context.js'
export type {
  Plugin,
  PluginConfig,
  PluginType,
  PluginDescriptor,
  PluginManifest,
  PluginLogger,
  RegistrationContext,
  RegistrationCompleteSnapshot,
  ToolPlugin,
  ProviderPlugin,
  ChannelPlugin,
  MemoryPlugin,
} from './plugin.js'
export type { Memory, MemoryEntry, MemorySearchResult } from './memory.js'
export type { Workspace, WorkspaceFile } from './workspace.js'
export type {
  ContextConfig,
  RuntimeConfig,
  AgentConfig,
  AgentToolFilter,
  HeartbeatConfig,
  LearningLoopConfig,
} from './config.js'
export type {
  DeploymentConfig,
  DeploymentTarget,
  DatahubConfig,
  ImageConfig,
  DockerConfig,
  ProxmoxConfig,
  ProxmoxNodeConfig,
  ProxmoxNetworkConfig,
  KubernetesConfig,
} from './deployment.js'
export type {
  StreamEvent,
  StreamHandler,
  SessionState,
  QueuedMessage,
  DelegationRequest,
  DelegationResult,
  TokenUsage,
  SilentResponse,
} from './events.js'
export type { CommandDef, RuntimeCommand } from './commands.js'
export { COMMAND_REGISTRY, COMMAND_NAMES } from './commands.js'
export type {
  SubagentSession,
  SubagentSpawnRequest,
  SubagentStatusResponse,
  SubagentManager,
} from './subagent.js'
export type { Skill, SkillManager } from './skill.js'
export type {
  TaskExecutorKind,
  TaskStatus,
  ContextRef,
  AcceptanceCriterion,
  TaskBudget,
  TaskUsage,
  TaskSpec,
  TaskEvent,
  TaskVerdict,
  TaskResult,
  TaskHandle,
  HarnessExecutorCapabilities,
  HarnessExecutor,
} from './task.js'
export type { CriterionReport, VerifierResult, EvalOutcome } from './task.js'
export {
  TASK_RESULT_FENCE,
  TASK_RESULT_JSON_SCHEMA,
  parseTaskResultJson,
  parseTaskResultBlock,
  validateTaskResultShape,
  taskResultFenceInstructions,
} from './task-result.js'
export type { ParsedTaskResult } from './task-result.js'
export type {
  WikiSourceRef,
  WikiHistoryEntryWire,
  WikiPageResponse,
  WikiIndexEntry,
  WikiIndexResponse,
} from './wiki.js'
// den event vocabulary — re-exported so executors emitting TaskEvent den
// payloads don't need a direct @rivetos/den-protocol dependency.
export type { AgentEventBody } from '@rivetos/den-protocol'
export type {
  HookEventName,
  HookContext,
  HookContextBase,
  ProviderBeforeContext,
  ProviderAfterContext,
  ProviderErrorContext,
  ToolBeforeContext,
  ToolAfterContext,
  SessionStartContext,
  SessionEndContext,
  TurnBeforeContext,
  TurnAfterContext,
  TurnReflectContext,
  SkillBeforeContext,
  SkillAfterContext,
  CompactBeforeContext,
  CompactAfterContext,
  DelegationBeforeContext,
  DelegationAfterContext,
  HookErrorMode,
  HookHandlerReturn,
  HookHandlerFn,
  HookRegistration,
  HookPipelineResult,
  HookPipeline,
  HookConfig,
} from './hooks.js'
export type {
  MeshNode,
  MeshNodeRole,
  MeshRegistry,
  MeshConfig,
  MeshDiscoveryConfig,
  MeshPeerConfig,
  MeshNodeEvent,
  MeshDelegationRoute,
} from './mesh.js'
export {
  splitMessage,
  getTextContent,
  hasImages,
  getToolResultText,
  getToolResultImages,
  toolResultHasImages,
} from './utils.js'
export { MODEL_DEFAULTS } from './defaults.js'
export type { ProviderName } from './defaults.js'
export type { GatewayRoute, GatewayHandle } from './gateway.js'
export type {
  GatewayErrorResponse,
  GatewayAuthMode,
  GatewayClientConfig,
  SessionSummary,
  SessionMessage,
  SessionsListResponse,
  HarnessSession,
  HarnessSessionsResponse,
  SessionMessagesResponse,
  SessionPostRequest,
  SessionPostAccepted,
  SessionPostReply,
  SessionWsFrame,
  TaskWire,
  TaskCreateRequest,
  TaskResponse,
  TasksListResponse,
  TaskSteerRequest,
  TaskSteerAccepted,
  TaskKillResponse,
  TaskWaitTimeoutResponse,
  CatalogAgent,
  CatalogCommand,
  CatalogExecutorEntry,
  CatalogSkillEntry,
  CatalogSheet,
  CatalogAgentsResponse,
  OutcomeBucket,
  OutcomesResponse,
  WikiGapsResponse,
  MeshDenNode,
  MeshOverview,
  NotificationFrame,
  TermConfigResponse,
  TermSpawnRequest,
  TermSpawnResponse,
  TermInjectRequest,
  TermInjectResponse,
  PtyInfo,
  TermListResponse,
  TermHelloFrame,
  TermExitFrame,
  TermControlFrame,
} from './gateway-api.js'
