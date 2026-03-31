/**
 * @rivetos/provider-openai-compat
 *
 * Generic OpenAI-compatible provider. Works with any endpoint that
 * speaks the OpenAI Chat Completions API:
 *
 * - llama-server (GERTY, Rivet Local)
 * - vLLM
 * - LM Studio
 * - OpenRouter
 * - Together AI
 * - Fireworks
 * - text-generation-webui
 * - LocalAI
 *
 * Streaming via SSE. Optional auth. Lenient JSON parsing for
 * llama-server's occasional malformed tool call arguments.
 * Configurable stream timeouts to prevent hanging on stalled models.
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

export interface OpenAICompatProviderConfig {
  baseUrl: string;              // e.g., 'http://10.4.20.12:8000/v1'
  apiKey?: string;              // Optional — local servers often need none
  model?: string;               // Default: 'default'
  maxTokens?: number;           // Default: 4096
  temperature?: number;         // Default: 0.6
  /** Custom provider ID (default: 'openai-compat') */
  id?: string;
  /** Custom display name (default: 'OpenAI Compatible') */
  name?: string;
  /** Max ms to wait for the first SSE chunk (default: 120000 = 2 min) */
  firstChunkTimeoutMs?: number;
  /** Max ms to wait between subsequent SSE chunks (default: 30000 = 30s) */
  chunkTimeoutMs?: number;
  /** Repetition penalty for llama-server (default: undefined — not sent) */
  repeatPenalty?: number;
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

class ReadTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Timed out after ${seconds}s`);
    this.name = 'ReadTimeoutError';
  }
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ReadTimeoutError(timeoutMs / 1000)),
      timeoutMs,
    );
    reader.read().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ---------------------------------------------------------------------------
// Message conversion (same as xAI — it's the same protocol)
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
    if (msg.toolCallId) oai.tool_call_id = msg.toolCallId;
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

export class OpenAICompatProvider implements Provider {
  id: string;
  name: string;
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private firstChunkTimeoutMs: number;
  private chunkTimeoutMs: number;
  private repeatPenalty: number | undefined;

  constructor(config: OpenAICompatProviderConfig) {
    this.id = config.id ?? 'openai-compat';
    this.name = config.name ?? 'OpenAI Compatible';
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey ?? '';
    this.model = config.model ?? 'default';
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.6;
    this.firstChunkTimeoutMs = config.firstChunkTimeoutMs ?? 120_000;
    this.chunkTimeoutMs = config.chunkTimeoutMs ?? 30_000;
    this.repeatPenalty = config.repeatPenalty;
  }

  // -----------------------------------------------------------------------
  // chatStream
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

    // llama-server specific: repeat_penalty reduces hallucination
    if (this.repeatPenalty !== undefined) {
      body.repeat_penalty = this.repeatPenalty;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown');
      yield { type: 'error', error: `${this.name} ${response.status}: ${err}` };
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
    let inThinking = false;
    let isFirstChunk = true;

    try {
      while (true) {
        // Apply timeout: longer for first chunk (model may be thinking),
        // shorter between subsequent chunks (stream should be flowing)
        const timeoutMs = isFirstChunk ? this.firstChunkTimeoutMs : this.chunkTimeoutMs;
        let readResult: ReadableStreamReadResult<Uint8Array>;

        try {
          readResult = await readWithTimeout(reader, timeoutMs);
        } catch (err: any) {
          if (err instanceof ReadTimeoutError) {
            const phase = isFirstChunk ? 'first response' : 'next chunk';
            yield {
              type: 'error',
              error: `Provider timed out waiting for ${phase} (${timeoutMs / 1000}s). The model may be overloaded or the context too large.`,
            };
            try { reader.cancel(); } catch {}
            return;
          }
          throw err; // Re-throw non-timeout errors (abort, network, etc.)
        }

        const { done, value } = readResult;
        if (done) break;

        isFirstChunk = false;
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


          // Native reasoning_content field (llama-server, OpenAI o-series)
          if (delta.reasoning_content) {
            yield { type: 'reasoning', delta: delta.reasoning_content as string };
          }
          // Text content — detect <think> blocks (Qwen via llama-server)
          if (delta.content) {
            const text = delta.content as string;

            if (text.includes('<think>')) {
              inThinking = true;
              const before = text.split('<think>')[0];
              const after = text.split('<think>')[1] ?? '';
              if (before) yield { type: 'text', delta: before };
              if (after) yield { type: 'reasoning', delta: after };
              continue;
            }
            if (text.includes('</think>')) {
              inThinking = false;
              const before = text.split('</think>')[0];
              const after = text.split('</think>')[1] ?? '';
              if (before) yield { type: 'reasoning', delta: before };
              if (after) yield { type: 'text', delta: after };
              continue;
            }

            if (inThinking) {
              yield { type: 'reasoning', delta: text };
            } else {
              yield { type: 'text', delta: text };
            }
          }

          // Tool calls
          if (delta.tool_calls) {
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
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                yield { type: 'tool_call_done', toolCall: { index: tc.index } };
              }
            }
          }

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
            try {
              args = JSON.parse(pending.args);
            } catch {
              // llama-server sometimes returns malformed JSON — best effort
              args = { raw: pending.args };
            }
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
      const headers: Record<string, string> = {};
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.baseUrl}/models`, { headers });
      return res.ok;
    } catch {
      return false;
    }
  }
}
