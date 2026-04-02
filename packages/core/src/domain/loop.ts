/**
 * Agent Loop — the core execution cycle.
 *
 * Consumes a streaming provider (AsyncIterable<LLMChunk>).
 * Supports: abort (/stop, /interrupt), steer, thinking levels,
 * tool iteration limits, and stream events.
 *
 * Pure domain logic. No I/O. Works with interfaces only.
 */

import type {
  Message,
  Provider,
  Tool,
  ToolDefinition,
  ToolCall,
  LLMChunk,
  LLMResponse,
  StreamEvent,
  StreamHandler,
  ChatOptions,
  ThinkingLevel,
} from '@rivetos/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  maxIterations?: number;
  systemPrompt: string;
  tools: Tool[];
  provider: Provider;
  thinking?: ThinkingLevel;
  onStream?: StreamHandler;
  /** Agent ID — passed to tools via ToolContext */
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface TurnResult {
  /** Final text response (empty if aborted) */
  response: string;
  /** Tools invoked during this turn */
  toolsUsed: string[];
  /** Number of tool iterations */
  iterations: number;
  /** Whether the turn was aborted (/stop or /interrupt) */
  aborted: boolean;
  /** Partial response text collected before abort (for /interrupt context) */
  partialResponse?: string;
  /** Token usage from provider */
  usage?: { promptTokens: number; completionTokens: number };
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

  /** Inject a message visible on the next tool iteration. */
  steer(message: string): void {
    this.steerQueue.push(message);
  }

  /**
   * Run one turn.
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
    let totalUsage = { promptTokens: 0, completionTokens: 0 };
    let partialResponse = '';
    let lastError = '';

    const hardCap = this.maxIterations * 5; // Safety cap (default: 75)

    while (iterations < hardCap) {
      if (signal?.aborted) {
        return { response: '', toolsUsed, iterations, aborted: true, partialResponse, usage: totalUsage };
      }

      // Check steer queue
      const steerMsg = this.steerQueue.shift();
      if (steerMsg) {
        messages.push({
          role: 'system',
          content: `[STEER — New message from user during execution]: ${steerMsg}`,
        });
        this.emit({ type: 'interrupt', content: `📨 Steer: ${steerMsg.slice(0, 100)}` });
      }

      // Stream from provider
      const options: ChatOptions = {
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        signal,
        thinking: this.config.thinking,
      };

      let textContent = '';
      let reasoningContent = '';
      const pendingToolCalls: Map<number, ToolCall> = new Map();
      const argsDelta: Map<number, string> = new Map();
      let hasToolCalls = false;

      try {
        for await (const chunk of this.config.provider.chatStream(messages, options)) {
          // Capture usage from ANY chunk (not just 'done') — prevents lost tracking on abort
          if (chunk.usage) {
            totalUsage.promptTokens = Math.max(totalUsage.promptTokens, chunk.usage.promptTokens);
            totalUsage.completionTokens = Math.max(totalUsage.completionTokens, chunk.usage.completionTokens);
          }

          if (signal?.aborted) {
            return { response: '', toolsUsed, iterations, aborted: true, partialResponse: textContent || partialResponse, usage: totalUsage };
          }

          switch (chunk.type) {
            case 'text':
              if (chunk.delta) {
                textContent += chunk.delta;
                this.emit({ type: 'text', content: chunk.delta });
              }
              break;

            case 'reasoning':
              if (chunk.delta) {
                reasoningContent += chunk.delta;
                this.emit({ type: 'reasoning', content: chunk.delta });
              }
              break;

            case 'tool_call_start':
              if (chunk.toolCall?.index !== undefined) {
                hasToolCalls = true;
                pendingToolCalls.set(chunk.toolCall.index, {
                  id: chunk.toolCall.id ?? `tc-${Date.now()}-${chunk.toolCall.index}`,
                  name: chunk.toolCall.name ?? '',
                  arguments: {},
                  thoughtSignature: chunk.toolCall.thoughtSignature,
                });
              }
              break;

            case 'tool_call_delta':
              // Arguments stream as JSON string deltas — accumulate
              if (chunk.toolCall?.index !== undefined && chunk.delta) {
                const tc = pendingToolCalls.get(chunk.toolCall.index);
                if (tc) {
                  // Store raw delta, parse when done
                  argsDelta.set(chunk.toolCall.index, (argsDelta.get(chunk.toolCall.index) ?? '') + chunk.delta);
                }
              }
              break;

            case 'tool_call_done':
              if (chunk.toolCall?.index !== undefined) {
                const tc = pendingToolCalls.get(chunk.toolCall.index);
                const rawArgs = argsDelta.get(chunk.toolCall.index);
                if (tc && rawArgs) {
                  try {
                    tc.arguments = JSON.parse(rawArgs);
                  } catch {
                    tc.arguments = { raw: rawArgs };
                  }
                  argsDelta.delete(chunk.toolCall.index);
                }
              }
              break;

            case 'done':
              if (chunk.usage) {
                totalUsage.promptTokens += chunk.usage.promptTokens;
                totalUsage.completionTokens += chunk.usage.completionTokens;
              }
              break;

            case 'error':
              lastError = chunk.error ?? 'Unknown provider error';
              this.emit({ type: 'error', content: lastError });
              break;
          }
        }
      } catch (err: any) {
        if (signal?.aborted) {
          return { response: '', toolsUsed, iterations, aborted: true, partialResponse: textContent || partialResponse, usage: totalUsage };
        }
        throw err;
      }

      // Text response — done
      if (!hasToolCalls) {
        // If no text was produced but an error occurred, surface the error
        // so the user doesn't get a blank message
        const finalResponse = textContent.trim() || (lastError ? `⚠️ ${lastError}` : '');
        return {
          response: finalResponse,
          toolsUsed,
          iterations,
          aborted: false,
          usage: totalUsage,
        };
      }

      // Tool calls — execute and loop
      const toolCalls = [...pendingToolCalls.values()];

      messages.push({
        role: 'assistant',
        content: textContent,
        toolCalls,
      });

      for (const tc of toolCalls) {
        if (signal?.aborted) {
          return { response: '', toolsUsed, iterations, aborted: true, partialResponse: textContent, usage: totalUsage };
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
            result = await tool.execute(tc.arguments, signal, { agentId: this.config.agentId });
          } catch (err: any) {
            result = `Error: ${err.message}`;
          }
        }

        this.emit({
          type: 'tool_result',
          content: `${result.startsWith('Error') ? '❌' : '✅'} ${tc.name}: ${result.slice(0, 200)}`,
        });

        messages.push({ role: 'tool', content: result, toolCallId: tc.id });
      }

      partialResponse = textContent;
      iterations++;

      // Progress update every maxIterations
      if (iterations > 0 && iterations % this.maxIterations === 0) {
        this.emit({
          type: 'status',
          content: `⏳ Still working... (${iterations} tool calls so far: ${[...new Set(toolsUsed)].join(', ')})`,
        });
      }
    }

    // Hard cap reached — safety stop
    this.emit({ type: 'error', content: `⚠️ Safety cap reached (${iterations} tool iterations)` });
    return {
      response: `I've used ${iterations} tool iterations (safety cap). Here's where I am — let me know if you want me to continue.`,
      toolsUsed,
      iterations,
      aborted: false,
      usage: totalUsage,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private emit(event: StreamEvent): void {
    this.config.onStream?.(event);
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
