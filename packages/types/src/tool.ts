/**
 * Tool interface — an action the agent can take.
 */

import type { ContentPart } from './message.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  /** The agent invoking this tool */
  agentId?: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Tool result — can be plain text or multimodal content (text + images).
 * Tools that return images (file_read on images, web_fetch screenshots,
 * MCP tools, etc.) return ContentPart[] with image blocks.
 */
export type ToolResult = string | ContentPart[];

export interface Tool extends ToolDefinition {
  execute(args: Record<string, unknown>, signal?: AbortSignal, context?: ToolContext): Promise<ToolResult>;
}
