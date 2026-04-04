/**
 * @rivetos/types — Shared interfaces for the RivetOS agent runtime.
 *
 * Interfaces only. Zero dependencies. Leaf package.
 * Every other package depends on this. Nothing else.
 */

export type { Message, ToolCall, ContentPart, TextPart, ImagePart } from './message.js'
export type { Provider, LLMResponse, LLMChunk, ChatOptions, ThinkingLevel } from './provider.js'
export { ProviderError } from './provider.js'
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
export type { Plugin, PluginConfig } from './plugin.js'
export type { Memory, MemoryEntry, MemorySearchResult } from './memory.js'
export type { Workspace, WorkspaceFile } from './workspace.js'
export type { RuntimeConfig, AgentConfig, HeartbeatConfig } from './config.js'
export type {
  StreamEvent,
  StreamHandler,
  SessionState,
  QueuedMessage,
  DelegationRequest,
  DelegationResult,
  TokenUsage,
  SilentResponse,
  RuntimeCommand,
} from './events.js'
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
export {
  splitMessage,
  getTextContent,
  hasImages,
  getToolResultText,
  getToolResultImages,
  toolResultHasImages,
} from './utils.js'
