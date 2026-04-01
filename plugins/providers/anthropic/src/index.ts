/**
 * @rivetos/provider-anthropic
 *
 * Anthropic Claude provider.
 * - API key mode (sk-ant-api03-): uses official SDK
 * - OAuth mode (sk-ant-oat01-): uses raw fetch (SDK doesn't handle OAuth correctly)
 *
 * The raw fetch approach matches the exact curl command proven to work.
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
import { TokenManager, detectAuthMode } from './oauth.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  tokenPath?: string;
}

// ---------------------------------------------------------------------------
// Thinking budgets
// ---------------------------------------------------------------------------

const THINKING_BUDGETS: Record<ThinkingLevel, number | null> = {
  off: null,
  low: 2000,
  medium: 10000,
  high: 50000,
};

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function convertMessages(messages: Message[]): { system: string; converted: any[] } {
  let system = '';
  const converted: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n\n' : '') + msg.content;
      continue;
    }

    if (msg.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.toolCallId ?? 'unknown',
          content: msg.content,
        }],
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const blocks: any[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      converted.push({ role: 'assistant', content: blocks });
      continue;
    }

    converted.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    });
  }

  return { system, converted };
}

function convertTools(tools: ToolDefinition[]): any[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements Provider {
  id = 'anthropic';
  name = 'Anthropic Claude';
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;
  private authMode: 'api_key' | 'oauth';
  private tokenManager: TokenManager | null = null;
  private initialized = false;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'claude-opus-4-6';
    this.maxTokens = config.maxTokens ?? 8192;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    this.authMode = detectAuthMode(config.apiKey);

    if (this.authMode === 'oauth') {
      this.tokenManager = new TokenManager(config.tokenPath);
      this.name = 'Anthropic Claude (OAuth)';
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.tokenManager) {
      await this.tokenManager.initialize(this.apiKey);
    }
    this.initialized = true;
  }

  private async getKey(): Promise<string> {
    await this.ensureInitialized();
    if (this.tokenManager) {
      return this.tokenManager.getAccessToken();
    }
    return this.apiKey;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const key = await this.getKey();

    if (this.authMode === 'oauth') {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': 'claude-cli/1.0.17',
        'x-app': 'cli',
      };
    }

    return {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    };
  }

  // -----------------------------------------------------------------------
  // chatStream — raw fetch with SSE parsing (works for both auth modes)
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const { system, converted } = convertMessages(messages);
    const headers = await this.buildHeaders();

    const body: any = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: converted,
      stream: true,
    };

    // System prompt — with ephemeral caching for token savings (~90% cheaper on cache hits)
    if (this.authMode === 'oauth') {
      const blocks: any[] = [
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } },
      ];
      if (system) blocks.push({ type: 'text', text: system, cache_control: { type: 'ephemeral' } });
      body.system = blocks;
    } else if (system) {
      body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }

    if (options?.tools?.length) {
      body.tools = convertTools(options.tools);
    }

    const thinking = options?.thinking ?? 'off';
    const budget = THINKING_BUDGETS[thinking];
    if (budget !== null) {
      // max_tokens must be > budget_tokens — always ensure full response space
      body.max_tokens = budget + this.maxTokens;
      body.thinking = { type: 'enabled', budget_tokens: budget };
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown');
      console.error(`[Anthropic] API error ${response.status}: ${err.slice(0, 500)}`);
      yield { type: 'error', error: `Anthropic ${response.status}: ${err.slice(0, 200)}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let toolCallIndex = 0;
    let currentBlockType = '';
    let usage = { promptTokens: 0, completionTokens: 0 };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on double newline (SSE event boundary)
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const eventBlock of events) {
          const lines = eventBlock.split('\n');
          let eventType = '';
          let data = '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              data = line.slice(6);
            }
          }

          if (!data || data === '[DONE]') continue;

          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          switch (parsed.type ?? eventType) {
            case 'message_start':
              if (parsed.message?.usage) {
                usage.promptTokens = parsed.message.usage.input_tokens ?? 0;
              }
              break;

            case 'content_block_start':
              currentBlockType = parsed.content_block?.type ?? '';
              if (currentBlockType === 'tool_use') {
                yield {
                  type: 'tool_call_start',
                  toolCall: {
                    index: toolCallIndex,
                    id: parsed.content_block.id,
                    name: parsed.content_block.name,
                  },
                };
              }
              break;

            case 'content_block_delta': {
              const delta = parsed.delta;
              if (delta?.type === 'text_delta') {
                yield { type: 'text', delta: delta.text };
              } else if (delta?.type === 'thinking_delta') {
                yield { type: 'reasoning', delta: delta.thinking };
              } else if (delta?.type === 'input_json_delta') {
                yield {
                  type: 'tool_call_delta',
                  delta: delta.partial_json,
                  toolCall: { index: toolCallIndex },
                };
              }
              break;
            }

            case 'content_block_stop':
              if (currentBlockType === 'tool_use') {
                yield { type: 'tool_call_done', toolCall: { index: toolCallIndex } };
                toolCallIndex++;
              }
              currentBlockType = '';
              break;

            case 'message_delta':
              if (parsed.usage) {
                usage.completionTokens = parsed.usage.output_tokens ?? 0;
              }
              break;

            case 'message_stop':
              break;

            case 'ping':
              break;

            case 'error':
              yield { type: 'error', error: parsed.error?.message ?? 'Stream error' };
              break;
          }
        }
      }
    } catch (err: any) {
      if (options?.signal?.aborted) return;
      console.error('[Anthropic] Stream error:', err.message);
      yield { type: 'error', error: err.message };
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
    let currentToolArgs = '';
    let currentToolId = '';
    let currentToolName = '';
    let usage = { promptTokens: 0, completionTokens: 0 };

    for await (const chunk of this.chatStream(messages, options)) {
      switch (chunk.type) {
        case 'text':
          text += chunk.delta ?? '';
          break;
        case 'reasoning':
          reasoning += chunk.delta ?? '';
          break;
        case 'tool_call_start':
          currentToolId = chunk.toolCall?.id ?? '';
          currentToolName = chunk.toolCall?.name ?? '';
          currentToolArgs = '';
          break;
        case 'tool_call_delta':
          currentToolArgs += chunk.delta ?? '';
          break;
        case 'tool_call_done':
          if (currentToolName) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(currentToolArgs); } catch { args = { raw: currentToolArgs }; }
            toolCalls.push({ id: currentToolId, name: currentToolName, arguments: args });
          }
          currentToolName = '';
          break;
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
      const headers = await this.buildHeaders();
      const body: any = {
        model: this.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      };
      if (this.authMode === 'oauth') {
        body.system = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }];
      }
      const res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      return res.ok || res.status === 429;
    } catch {
      return false;
    }
  }
}
