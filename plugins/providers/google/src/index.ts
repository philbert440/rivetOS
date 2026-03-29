/**
 * @rivetos/provider-google
 *
 * Google Gemini provider. Uses the Generative Language API (native, not OpenAI-compat).
 * Streaming via SSE. Supports tool calling, thinking (thought summaries), and grounding.
 *
 * API: https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent
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

export interface GoogleProviderConfig {
  apiKey: string;
  model?: string;          // Default: 'gemini-2.5-pro'
  maxTokens?: number;      // Default: 8192
  baseUrl?: string;        // Default: 'https://generativelanguage.googleapis.com/v1beta'
}

// ---------------------------------------------------------------------------
// Thinking mapping
// ---------------------------------------------------------------------------

const THINKING_BUDGETS: Record<ThinkingLevel, number | null> = {
  off: 0,
  low: 1024,
  medium: 8192,
  high: 32768,
};

// ---------------------------------------------------------------------------
// Message conversion — Gemini uses a different format
// ---------------------------------------------------------------------------

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: string } } };

function convertMessages(messages: Message[]): { systemInstruction?: string; contents: GeminiContent[] } {
  let systemInstruction: string | undefined;
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = (systemInstruction ?? '') + (systemInstruction ? '\n\n' : '') + msg.content;
      continue;
    }

    if (msg.role === 'tool') {
      // Tool results go as user role with functionResponse parts
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.toolCallId ?? 'unknown',
            response: { content: msg.content },
          },
        }],
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (msg.content) {
        parts.push({ text: msg.content });
      }
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        }
      }
      if (parts.length > 0) {
        contents.push({ role: 'model', parts });
      }
      continue;
    }

    // User message
    contents.push({ role: 'user', parts: [{ text: msg.content }] });
  }

  return { systemInstruction, contents };
}

function convertTools(tools: ToolDefinition[]): any {
  return {
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GoogleProvider implements Provider {
  id = 'google';
  name = 'Google Gemini';
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;

  constructor(config: GoogleProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'gemini-2.5-pro';
    this.maxTokens = config.maxTokens ?? 8192;
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  // -----------------------------------------------------------------------
  // chatStream
  // -----------------------------------------------------------------------

  async *chatStream(messages: Message[], options?: ChatOptions): AsyncIterable<LLMChunk> {
    const { systemInstruction, contents } = convertMessages(messages);

    const body: any = {
      contents,
      generationConfig: {
        maxOutputTokens: this.maxTokens,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    if (options?.tools?.length) {
      body.tools = [convertTools(options.tools)];
    }

    // Thinking config
    const thinking = options?.thinking ?? 'off';
    const budget = THINKING_BUDGETS[thinking];
    if (budget !== null && budget > 0) {
      body.generationConfig.thinkingConfig = {
        thinkingBudget: budget,
      };
    }

    const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent?key=${this.apiKey}&alt=sse`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const err = await response.text().catch(() => 'unknown');
      yield { type: 'error', error: `Google ${response.status}: ${err}` };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let toolCallIndex = 0;
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
          if (!data || data === '[DONE]') continue;

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          // Process candidates
          const candidates = event.candidates ?? [];
          for (const candidate of candidates) {
            const parts = candidate.content?.parts ?? [];
            for (const part of parts) {
              // Text
              if (part.text !== undefined) {
                yield { type: 'text', delta: part.text };
              }

              // Thinking/reasoning
              if (part.thought !== undefined) {
                yield { type: 'reasoning', delta: part.thought };
              }

              // Function call
              if (part.functionCall) {
                yield {
                  type: 'tool_call_start',
                  toolCall: {
                    index: toolCallIndex,
                    id: `gemini-tc-${Date.now()}-${toolCallIndex}`,
                    name: part.functionCall.name,
                  },
                };
                // Gemini sends complete args in one shot (not streamed)
                yield {
                  type: 'tool_call_delta',
                  delta: JSON.stringify(part.functionCall.args ?? {}),
                  toolCall: { index: toolCallIndex },
                };
                yield {
                  type: 'tool_call_done',
                  toolCall: { index: toolCallIndex },
                };
                toolCallIndex++;
              }
            }
          }

          // Usage metadata
          if (event.usageMetadata) {
            usage.promptTokens = event.usageMetadata.promptTokenCount ?? 0;
            usage.completionTokens = event.usageMetadata.candidatesTokenCount ?? 0;
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
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(currentToolArgs); } catch { args = { raw: currentToolArgs }; }
          toolCalls.push({ id: currentToolId, name: currentToolName, arguments: args });
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
      const res = await fetch(
        `${this.baseUrl}/models/${this.model}?key=${this.apiKey}`,
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}
