/**
 * @rivetos/types — Shared interfaces for the RivetOS agent runtime.
 *
 * Interfaces only. Zero dependencies. Leaf package.
 * Every other package depends on this. Nothing else.
 */

export type { Message, ToolCall, ContentPart, TextPart, ImagePart } from './message.js'
export type {
  Provider,
  LLMResponse,
  LLMChunk,
  ChatOptions,
  ThinkingLevel,
  ProviderErrorCode,
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
export type {
  Plugin,
  PluginConfig,
  PluginType,
  PluginManifest,
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
export type { SubagentSession, SubagentSpawnRequest, SubagentManager } from './subagent.js'
export type { Skill, SkillManager } from './skill.js'
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
  FallbackConfig,
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
