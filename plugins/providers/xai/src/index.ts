/**
 * @rivetos/provider-xai
 *
 * xAI Grok provider. OpenAI-compatible streaming with xAI-specific features:
 * - x-grok-conv-id header for conversation caching
 * - reasoning_effort parameter for thinking control
 * - Native SSE streaming
 */

import type {
  Provider,
  Message,
  ToolCall,
  ToolDefinition,
  ChatOptions,
  LLMChunk,
  LLMResponse,
  ThinkingLevel,
} from '@rivetos/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface XAIProviderConfig {
  apiKey: string;
  model?: string;          // Default: 'grok-4-1-fast'
  maxTokens?: number;      // Default: 8192
  baseUrl?: string;        // Default: 'https://api.x.ai/v1'
  temperature?: number;    // Default: 0.7
  /** Conversation ID for xAI caching (reuse across turns for cost savings) */
  convId?: string;
}

// ---------------------------------------------------------------------------
// Thinking → reasoning_effort mapping
// ---------------------------------------------------------------------------

const REASONING_EFFORT: Record<ThinkingLevel, string | null> = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
};

// ---------------------------------------------------------------------------
// Message conversion (OpenAI format)
// ---------------------------------------------------------------------------

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function convertMessages(messages: Message[]): OAIMessage[] {
  return messages.map((msg) => {
    const oai: OAIMessage = { role: msg.role, content: msg.content || null };

    if (msg.toolCalls?.length) {
      oai.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }

    if (msg.toolCallId) {
      oai.tool_call_id = msg.toolCallId;
    }

    return oai;
  });
}

function convertTools(tools: ToolDefinition[]): any[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
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
  private maxTokens: number;
  private baseUrl: string;
  private temperature: number;
  private convId: string;

  constructor(config: XAIProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'grok-4-1-fast';
    this.maxTokens = config.maxTokens ?? 8192;
    this.baseUrl = config.baseUrl ?? 'https://api.x.ai/v1';
    this.temperature = config.temperature ?? 0.7;
    this.convId = config.convId ?? '';
  }

  // -----------------------------------------------------------------------
  // chatStream — SSE streaming
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const body: any = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: convertMessages(messages),
      stream: true,
    };

    if (options?.tools?.length) {
      body.tools = convertTools(options.tools);
    }

    // Thinking → reasoning_effort
    const thinking = options?.thinking ?? 'off';
    const effort = REASONING_EFFORT[thinking];
    if (effort) {
      body.reasoning_effort = effort;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.convId) {
      headers['x-grok-conv-id'] = this.convId;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown');
      yield { type: 'error', error: `xAI ${response.status}: ${err}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = { promptTokens: 0, completionTokens: 0 };

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

          const choice = event.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            yield { type: 'text', delta: delta.content };
          }

          // Reasoning content (xAI may include this)
          if (delta.reasoning_content) {
            yield { type: 'reasoning', delta: delta.reasoning_content };
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.name) {
                // Start of a new tool call
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

          // Finish reason
          if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
            // Emit tool_call_done for any pending tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                yield { type: 'tool_call_done', toolCall: { index: tc.index } };
              }
            }
          }

          // Usage
          if (event.usage) {
            usage.promptTokens = event.usage.prompt_tokens ?? 0;
            usage.completionTokens = event.usage.completion_tokens ?? 0;
          }
        }
      }
    } finally {
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
