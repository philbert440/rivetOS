/**
 * Core message types — the fundamental unit of conversation.
 */

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
  /** Gemini 3 thought signature — must be passed back for function calling to work */
  thoughtSignature?: string;
}
