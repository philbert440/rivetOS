/**
 * Provider interface — talks to an LLM.
 */

import type { Message, ToolCall } from './message.js';
import type { ToolDefinition } from './tool.js';

// ---------------------------------------------------------------------------
// Thinking / Reasoning Control
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export interface ChatOptions {
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  thinking?: ThinkingLevel;
}

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

export interface LLMResponse {
  type: 'text' | 'tool_calls';
  content?: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMChunk {
  type: 'text' | 'reasoning' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_done' | 'done' | 'error';
  delta?: string;
  toolCall?: Partial<ToolCall> & { index?: number };
  usage?: { promptTokens: number; completionTokens: number };
  error?: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface Provider {
  id: string;
  name: string;
  chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk>;
  chat?(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
}
