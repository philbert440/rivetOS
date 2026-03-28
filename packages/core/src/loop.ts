/**
 * Agent Loop — the core execution cycle.
 *
 * Message in → build context → call LLM → execute tools → repeat → respond.
 *
 * Supports:
 * - AbortSignal for /stop (cancels mid-turn)
 * - Steer queue (inject messages between tool iterations)
 * - Tool iteration limit (prevents runaway loops)
 * - Stream events for reasoning/tool visibility
 */

import type {
  Message,
  Provider,
  Tool,
  ToolDefinition,
  ToolCall,
  LLMResponse,
  StreamEvent,
  StreamHandler,
} from '@rivetos/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  /** Max tool call iterations per turn (default: 15) */
  maxIterations?: number;
  /** System prompt (workspace context + personality) */
  systemPrompt: string;
  /** Available tools */
  tools: Tool[];
  /** LLM provider */
  provider: Provider;
  /** Stream event handler (for reasoning, tool visibility) */
  onStream?: StreamHandler;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface TurnResult {
  response: string;
  toolsUsed: string[];
  iterations: number;
  aborted: boolean;
}

// ---------------------------------------------------------------------------
// Agent Loop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private config: AgentLoopConfig;
  private maxIterations: number;
  private steerQueue: string[] = [];

  constructor(config: AgentLoopConfig) {
    this.config = config;
    this.maxIterations = config.maxIterations ?? 15;
  }

  /**
   * Inject a message that the agent will see between tool iterations.
   */
  steer(message: string): void {
    this.steerQueue.push(message);
  }

  /**
   * Run one turn of the agent loop.
   *
   * @param userMessage - The user's message
   * @param history - Conversation history (excluding system prompt)
   * @param signal - AbortSignal for cancellation (/stop)
   * @returns The agent's final text response
   */
  async run(userMessage: string, history: Message[], signal?: AbortSignal): Promise<TurnResult> {
    const messages: Message[] = [
      { role: 'system', content: this.config.systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ];

    const toolDefs: ToolDefinition[] = this.config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const toolsUsed: string[] = [];
    let iterations = 0;

    while (iterations < this.maxIterations) {
      // Check abort
      if (signal?.aborted) {
        return { response: '', toolsUsed, iterations, aborted: true };
      }

      // Check steer queue
      const steerMessage = this.steerQueue.shift();
      if (steerMessage) {
        messages.push({
          role: 'system',
          content: `[STEER — New message from user during execution]: ${steerMessage}`,
        });
        this.emit({ type: 'interrupt', content: `📨 Steer: ${steerMessage.slice(0, 100)}` });
      }

      // Call LLM
      let response: LLMResponse;
      try {
        response = await this.config.provider.chat(messages, toolDefs, signal);
      } catch (err: any) {
        if (signal?.aborted) {
          return { response: '', toolsUsed, iterations, aborted: true };
        }
        throw err;
      }

      // Text response — we're done
      if (response.type === 'text') {
        const text = response.content ?? '';
        // Parse out thinking blocks for stream events
        const cleaned = this.parseThinking(text);
        return { response: cleaned, toolsUsed, iterations, aborted: false };
      }

      // Tool calls — execute and loop
      if (response.type === 'tool_calls' && response.toolCalls?.length) {
        // Add assistant message with tool calls to history
        messages.push({
          role: 'assistant',
          content: '',
          toolCalls: response.toolCalls,
        });

        for (const tc of response.toolCalls) {
          if (signal?.aborted) {
            return { response: '', toolsUsed, iterations, aborted: true };
          }

          const tool = this.config.tools.find((t) => t.name === tc.name);
          toolsUsed.push(tc.name);

          this.emit({
            type: 'tool_start',
            content: `🔧 ${tc.name}`,
            metadata: { args: this.summarizeArgs(tc.arguments) },
          });

          let result: string;
          if (!tool) {
            result = `Error: Unknown tool "${tc.name}"`;
          } else {
            try {
              result = await tool.execute(tc.arguments, signal);
            } catch (err: any) {
              result = `Error: ${err.message}`;
            }
          }

          this.emit({
            type: 'tool_result',
            content: `${result.startsWith('Error') ? '❌' : '✅'} ${tc.name}: ${result.slice(0, 200)}`,
          });

          // Add tool result to history
          messages.push({
            role: 'tool',
            content: result,
            toolCallId: tc.id,
          });
        }

        iterations++;
        continue;
      }

      // Unexpected response type — bail
      return { response: response.content ?? '', toolsUsed, iterations, aborted: false };
    }

    // Max iterations reached
    this.emit({
      type: 'error',
      content: `⚠️ Max tool iterations (${this.maxIterations}) reached`,
    });

    return {
      response: `I hit the maximum number of tool iterations (${this.maxIterations}). Here's what I was working on — you may want to continue manually.`,
      toolsUsed,
      iterations,
      aborted: false,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private emit(event: StreamEvent): void {
    this.config.onStream?.(event);
  }

  private parseThinking(text: string): string {
    const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
    let match;
    let clean = text;

    while ((match = thinkingRegex.exec(text)) !== null) {
      this.emit({ type: 'reasoning', content: match[1].trim() });
      clean = clean.replace(match[0], '');
    }

    return clean.trim();
  }

  private summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > 200) {
        summary[key] = value.slice(0, 200) + '…';
      } else {
        summary[key] = value;
      }
    }
    return summary;
  }
}
