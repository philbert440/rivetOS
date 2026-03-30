/**
 * @rivetos/provider-xai
 *
 * xAI Grok provider using the Responses API (/v1/responses).
 * - Stateless for now (full input each turn) — stateful via previous_response_id later
 * - Encrypted reasoning passthrough
 * - Native SSE streaming
 * - No reasoning_effort (grok-4 always reasons)
 * - store: false (we manage our own memory)
 * - 1-hour timeout for reasoning models
 */

import type {
  Provider,
  Message,
  ToolCall,
  ToolDefinition,
  ChatOptions,
  LLMChunk,
  LLMResponse,
} from '@rivetos/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface XAIProviderConfig {
  apiKey: string;
  model?: string;           // Default: 'grok-4.20-reasoning'
  baseUrl?: string;         // Default: 'https://api.x.ai/v1'
  temperature?: number;     // Default: not set (reasoning models don't use it)
  store?: boolean;          // Default: false (we manage our own memory)
  timeoutMs?: number;       // Default: 3600000 (1 hour for reasoning)
}

// ---------------------------------------------------------------------------
// Responses API input types
// ---------------------------------------------------------------------------

type ResponsesInput =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { type: 'function_call_output'; call_id: string; output: string };

// ---------------------------------------------------------------------------
// Message conversion (Responses API format)
// ---------------------------------------------------------------------------

function convertMessages(messages: Message[]): ResponsesInput[] {
  const result: ResponsesInput[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool') {
      // Tool results → function_call_output items
      result.push({
        type: 'function_call_output',
        call_id: msg.toolCallId ?? '',
        output: msg.content || '',
      });
    } else if (msg.role === 'assistant') {
      // Assistant messages — content only, tool calls are tracked server-side
      if (msg.content) {
        result.push({ role: 'assistant', content: msg.content });
      }
    } else {
      // system / user — pass through
      result.push({ role: msg.role, content: msg.content || '' });
    }
  }

  return result;
}

function convertTools(tools: ToolDefinition[]): any[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class XAIProvider implements Provider {
  id = 'xai';
  name = 'xAI Grok';
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private temperature: number | undefined;
  private store: boolean;
  private timeoutMs: number;

  constructor(config: XAIProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'grok-4.20-reasoning';
    this.baseUrl = config.baseUrl ?? 'https://api.x.ai/v1';
    this.temperature = config.temperature;
    this.store = config.store ?? false;
    this.timeoutMs = config.timeoutMs ?? 3_600_000;
  }

  // -----------------------------------------------------------------------
  // chatStream — SSE streaming via Responses API
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: convertMessages(messages),
      stream: true,
      store: this.store,
      include: ['reasoning.encrypted_content'],
    };

    if (this.temperature !== undefined) {
      body.temperature = this.temperature;
    }

    if (options?.tools?.length) {
      body.tools = convertTools(options.tools);
    }

    const controller = new AbortController();
    const signal = options?.signal;

    // Wire up external abort signal
    if (signal) {
      if (signal.aborted) {
        yield { type: 'error', error: 'Aborted' };
        return;
      }
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    // Timeout for reasoning models
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      yield { type: 'error', error: `xAI fetch failed: ${err.message}` };
      return;
    }

    if (!response.ok) {
      clearTimeout(timeout);
      const err = await response.text().catch(() => 'unknown');
      yield { type: 'error', error: `xAI ${response.status}: ${err}` };
      return;
    }

    if (!response.body) {
      clearTimeout(timeout);
      yield { type: 'error', error: 'No response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = { promptTokens: 0, completionTokens: 0 };

    // Track tool calls being assembled
    const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
    let toolCallIndex = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          // Responses API streaming: events have a `type` field
          // Handle both Responses API event format and Chat Completions delta format
          if (event.type === 'response.output_item.added') {
            const item = event.item;
            if (item?.type === 'function_call') {
              const idx = toolCallIndex++;
              pendingToolCalls.set(idx, {
                id: item.call_id ?? item.id ?? `tc-${idx}`,
                name: item.name ?? '',
                args: '',
              });
              yield {
                type: 'tool_call_start',
                toolCall: { index: idx, id: item.call_id ?? item.id, name: item.name },
              };
            }
          } else if (event.type === 'response.function_call_arguments.delta') {
            // Find the pending tool call and append args
            const lastIdx = toolCallIndex - 1;
            const pending = pendingToolCalls.get(lastIdx);
            if (pending) {
              pending.args += event.delta ?? '';
              yield {
                type: 'tool_call_delta',
                delta: event.delta ?? '',
                toolCall: { index: lastIdx },
              };
            }
          } else if (event.type === 'response.function_call_arguments.done') {
            const lastIdx = toolCallIndex - 1;
            yield { type: 'tool_call_done', toolCall: { index: lastIdx } };
          } else if (event.type === 'response.output_text.delta') {
            if (event.delta) {
              yield { type: 'text', delta: event.delta };
            }
          } else if (event.type === 'response.reasoning.delta') {
            if (event.delta) {
              yield { type: 'reasoning', delta: event.delta };
            }
          } else if (event.type === 'response.completed' || event.type === 'response.done') {
            // Extract usage from the completed response
            const resp = event.response;
            if (resp?.usage) {
              usage.promptTokens = resp.usage.input_tokens ?? resp.usage.prompt_tokens ?? 0;
              usage.completionTokens = resp.usage.output_tokens ?? resp.usage.completion_tokens ?? 0;
            }
          }

          // Fallback: Chat Completions delta format (in case xAI sends it)
          const choice = event.choices?.[0];
          if (choice) {
            const delta = choice.delta;
            if (delta?.content) {
              yield { type: 'text', delta: delta.content };
            }
            if (delta?.reasoning_content) {
              yield { type: 'reasoning', delta: delta.reasoning_content };
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  yield {
                    type: 'tool_call_start',
                    toolCall: { index: tc.index, id: tc.id, name: tc.function.name },
                  };
                }
                if (tc.function?.arguments) {
                  yield {
                    type: 'tool_call_delta',
                    delta: tc.function.arguments,
                    toolCall: { index: tc.index },
                  };
                }
              }
            }
            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  yield { type: 'tool_call_done', toolCall: { index: tc.index } };
                }
              }
            }
          }

          // Usage from Chat Completions format
          if (event.usage) {
            usage.promptTokens = event.usage.prompt_tokens ?? 0;
            usage.completionTokens = event.usage.completion_tokens ?? 0;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }

    yield { type: 'done', usage };
  }

  // -----------------------------------------------------------------------
  // chat — non-streaming convenience
  // -----------------------------------------------------------------------

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    let text = '';
    let reasoning = '';
    const toolCalls: ToolCall[] = [];
    const pendingArgs: Map<number, { id: string; name: string; args: string }> = new Map();
    let usage = { promptTokens: 0, completionTokens: 0 };

    for await (const chunk of this.chatStream(messages, options)) {
      switch (chunk.type) {
        case 'text':
          text += chunk.delta ?? '';
          break;
        case 'reasoning':
          reasoning += chunk.delta ?? '';
          break;
        case 'tool_call_start': {
          const idx = chunk.toolCall?.index ?? 0;
          pendingArgs.set(idx, {
            id: chunk.toolCall?.id ?? `tc-${idx}`,
            name: chunk.toolCall?.name ?? '',
            args: '',
          });
          break;
        }
        case 'tool_call_delta': {
          const idx = chunk.toolCall?.index ?? 0;
          const pending = pendingArgs.get(idx);
          if (pending) pending.args += chunk.delta ?? '';
          break;
        }
        case 'tool_call_done': {
          const idx = chunk.toolCall?.index ?? 0;
          const pending = pendingArgs.get(idx);
          if (pending) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(pending.args); } catch { args = { raw: pending.args }; }
            toolCalls.push({ id: pending.id, name: pending.name, arguments: args });
            pendingArgs.delete(idx);
          }
          break;
        }
        case 'done':
          if (chunk.usage) usage = chunk.usage;
          break;
        case 'error':
          throw new Error(chunk.error);
      }
    }

    if (toolCalls.length > 0) {
      return { type: 'tool_calls', toolCalls, content: text, usage };
    }

    const fullContent = reasoning ? `<thinking>${reasoning}</thinking>\n\n${text}` : text;
    return { type: 'text', content: fullContent, usage };
  }

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
