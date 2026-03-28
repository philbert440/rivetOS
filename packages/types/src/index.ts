/**
 * @rivetos/types — Shared interfaces for the RivetOS agent runtime.
 *
 * These are the plugin contracts. Implement a Provider, Channel, or Tool
 * and the core runtime knows how to use it. No base classes, no inheritance,
 * no framework coupling — just interfaces.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider — talks to an LLM
// ---------------------------------------------------------------------------

export interface LLMResponse {
  type: 'text' | 'tool_calls';
  content?: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface Provider {
  id: string;
  name: string;
  chat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Channel — receives and sends messages on a surface (Telegram, Discord, etc.)
// ---------------------------------------------------------------------------

export interface InboundMessage {
  id: string;
  userId: string;
  username?: string;
  displayName?: string;
  channelId: string;
  /** Platform-specific chat type */
  chatType: string;
  text: string;
  /** Platform name: 'telegram', 'discord', 'cli', etc. */
  platform: string;
  /** Which agent should handle this (from channel binding config) */
  agent?: string;
  /** Reply context */
  replyToMessageId?: string;
  /** Attachments (photos, files, voice) */
  attachments?: Attachment[];
  /** Raw platform-specific metadata */
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface Attachment {
  type: 'photo' | 'voice' | 'document' | 'video';
  url?: string;
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  /** For photos */
  width?: number;
  height?: number;
  /** For voice/video */
  duration?: number;
}

export interface OutboundMessage {
  channelId: string;
  text?: string;
  replyToMessageId?: string;
  /** Inline buttons / action rows */
  buttons?: Button[][];
  /** Rich embed (Discord) */
  embed?: EmbedData;
  /** File/photo attachment */
  attachment?: { name: string; content: Buffer | string };
  /** Suppress notifications */
  silent?: boolean;
  /** Platform-specific options */
  metadata?: Record<string, unknown>;
}

export interface Button {
  text: string;
  callbackData: string;
  style?: 'primary' | 'success' | 'danger';
}

export interface EmbedData {
  title?: string;
  description: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: string;
}

export interface Channel {
  id: string;
  platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<string | null>;
  onMessage(handler: (message: InboundMessage) => Promise<void>): void;
  onCommand(handler: (command: string, args: string, message: InboundMessage) => Promise<void>): void;
}

// ---------------------------------------------------------------------------
// Tool — an action the agent can take
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Tool extends ToolDefinition {
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

// ---------------------------------------------------------------------------
// Memory — persistent storage and retrieval
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id?: string;
  sessionId: string;
  agent: string;
  channel: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  role: string;
  agent: string;
  relevanceScore: number;
  createdAt: Date;
}

export interface Memory {
  append(entry: MemoryEntry): Promise<string>;
  search(query: string, options?: { agent?: string; limit?: number }): Promise<MemorySearchResult[]>;
  getContextForTurn(query: string, agent: string, options?: { maxTokens?: number }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Workspace — file-based configuration injected into system prompt
// ---------------------------------------------------------------------------

export interface WorkspaceFile {
  name: string;
  path: string;
  content: string;
}

export interface Workspace {
  load(): Promise<WorkspaceFile[]>;
  read(filename: string): Promise<string | null>;
  write(filename: string, content: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Runtime — lifecycle and control
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  /** Agent definitions */
  agents: AgentConfig[];
  /** Workspace directory */
  workspaceDir: string;
  /** Default agent for unrouted messages */
  defaultAgent: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  provider: string;
  /** Workspace files to inject (default: all) */
  workspaceFiles?: string[];
  /** Provider-specific overrides */
  providerConfig?: Record<string, unknown>;
}

export interface StreamEvent {
  type: 'text' | 'reasoning' | 'tool_start' | 'tool_result' | 'status' | 'interrupt' | 'done' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export type StreamHandler = (event: StreamEvent) => void;
