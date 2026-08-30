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
  HarnessErrorCode,
} from './errors.js'
export {
  RivetError,
  ChannelError,
  MemoryError,
  ConfigError,
  ToolError,
  DelegationError,
  RuntimeError,
  HarnessError,
  HARNESS_ERROR_CODES,
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
export { buildLocalSessionContext } from './session-context.js'
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
} from './plugin.js'
export type { Memory, MemoryEntry, MemorySearchResult } from './memory.js'
export { isUsableUserDb, parseUserDbs } from './user-dbs.js'
export type { UserDbEntry } from './user-dbs.js'
export { TRUSTED_USER_HEADER, routedUserFromHeaders, routedUserResult } from './trusted-user.js'
export {
  mergeUserDbs,
  parseUsersRegistry,
  registryFromEnv,
  resolveUser,
  sessionVisibleTo,
} from './users-registry.js'
export type { ResolveUserResult, UserContext, UserRecord, UsersRegistry } from './users-registry.js'
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
// Harness control plane (docs/plans/harness-control-plane.md). `SessionSummary`
// is re-exported as `HarnessSessionSummary`: the bare name is already taken by
// the den chat-session summary in gateway-api.js.
export type {
  HarnessId,
  SessionId,
  HarnessCapabilities,
  ApprovalDecision,
  HarnessEvent,
  StartSessionOpts,
  UserTurn,
  HarnessDriver,
} from './harness.js'
export type { SessionSummary as HarnessSessionSummary } from './harness.js'
export {
  HARNESS_IDS,
  SYSTEM_PROMPT_MAX_CHARS,
  SYSTEM_PROMPT_INJECT_HEADING,
  prefixSystemPrompt,
} from './harness.js'
export {
  parseSessionId,
  formatSessionId,
  isSessionId,
  encodeSessionIdSegment,
  decodeSessionIdSegment,
} from './harness-session-id.js'
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
export { hasImages, getToolResultText, getToolResultImages, toolResultHasImages } from './utils.js'
export { sharedDir, sharedPath } from './shared-dir.js'
export { installRoot, installPath } from './install-root.js'
export { splitHermesReasoning, stripAnsi } from './hermes-reasoning.js'
export type { HermesSplit } from './hermes-reasoning.js'
export { MODEL_DEFAULTS } from './defaults.js'
export type { GatewayRoute } from './gateway.js'
export { mergeTranscriptWindow } from './gateway-api.js'
export type {
  GatewayAuthMode,
  GatewayClientConfig,
  GatewayTlsClientConfig,
  SessionSummary,
  SessionMessage,
  MessageUsage,
  SessionsListResponse,
  HarnessSession,
  HarnessSessionsResponse,
  HarnessTranscriptTool,
  HarnessTranscriptTurn,
  HarnessTranscriptResponse,
  HarnessDescriptor,
  HarnessesResponse,
  HarnessSessionListResponse,
  HarnessRedirect,
  HarnessSessionResponse,
  HarnessSessionTranscriptResponse,
  HarnessTurnAccepted,
  HarnessApprovalAccepted,
  SessionMessagesResponse,
  SessionPostRequest,
  SessionPostAccepted,
  SessionPostReply,
  SessionWsFrame,
  SessionWsClientMessage,
  TranscriptWsFrame,
  TaskWire,
  TaskCreateRequest,
  TaskResponse,
  TasksListResponse,
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
  MemorySearchHit,
  MemorySearchResponse,
  MemoryBrowseMessage,
  MemoryBrowseResponse,
  MemoryStatsResponse,
  MemoryHealthResponse,
  MeshDenNode,
  MeshOverview,
  NotificationFrame,
  TermConfigResponse,
  TermSpawnRequest,
  TermSpawnResponse,
  TermInjectRequest,
  TermInjectResponse,
  AudioMicStatus,
  AudioMicHealth,
  AudioMicServerFrame,
  AudioMicClientFrame,
  PtyInfo,
  TermListResponse,
  TermHelloFrame,
  TermExitFrame,
  TermControlFrame,
  DenSessionInfo,
  DenSessionsResponse,
  FileEntry,
  FilesListResponse,
  FilesUploadResponse,
  StagedUploadResponse,
  VoiceSpeakRequest,
  VoiceTranscribeResponse,
  FilesMutateResponse,
  MeshDevice,
  MeshDevicePending,
  DeviceEnrollConfig,
  DeviceEnrollQr,
  DevicesListResponse,
  DeviceOpenResponse,
  AgentPreset,
  AgentsListResponse,
  AgentCreateRequest,
  AgentUpdateRequest,
  AgentResponse,
  WorkflowFieldType,
  WorkflowField,
  WorkflowOutlineStep,
  WorkflowDefSummary,
  WorkflowDiagnosticSeverity,
  WorkflowDiagnostic,
  WorkflowValidateResponse,
  WorkflowsListResponse,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowRunsListResponse,
  WorkflowOpenGate,
  WorkflowJournalEntry,
  WorkflowRunDetail,
  WorkflowRunDetailResponse,
  WorkflowStartRunRequest,
  WorkflowStartRunResponse,
  WorkflowResumeRequest,
  WorkflowResumeResponse,
  WorkflowKillResponse,
  WorkflowContractErrorResponse,
} from './gateway-api.js'
