/**
 * Tool interface — an action the agent can take.
 */

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

export interface Tool extends ToolDefinition {
  execute(args: Record<string, unknown>, signal?: AbortSignal, context?: ToolContext): Promise<string>;
}
