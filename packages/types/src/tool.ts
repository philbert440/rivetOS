/**
 * Tool interface — an action the agent can take.
 */

import type { ContentPart } from './message.js'
import type { SessionContext } from './session-context.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolContext {
  /** The agent invoking this tool */
  agentId?: string
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /** Working directory for file-based tools */
  workingDir?: string
  /**
   * Full session envelope — populated by the tool executor when available.
   *
   * Added 2026-04-24 as part of the MCP overhaul (plan §4.3). Optional for
   * now so the existing `agentId` / `workingDir` shim path keeps working
   * while call sites are migrated. New tools should read from `session`
   * when present; fall back to the flat fields when not.
   */
  session?: SessionContext
}

/**
 * Tool result — can be plain text or multimodal content (text + images).
 * Tools that return images (file_read on images, web_fetch screenshots,
 * MCP tools, etc.) return ContentPart[] with image blocks.
 */
export type ToolResult = string | ContentPart[]

export interface Tool extends ToolDefinition {
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolContext,
  ): Promise<ToolResult>
}
