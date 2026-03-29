/**
 * Tool interface — an action the agent can take.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Tool extends ToolDefinition {
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}
