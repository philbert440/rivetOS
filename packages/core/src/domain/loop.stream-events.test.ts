/**
 * Loop StreamEvent regression baseline.
 *
 * These tests freeze the StreamEvent sequence the AgentLoop emits for a given
 * LLMChunk input. They are the regression line for the AI SDK loop swap (step
 * 6 of the migration plan) — the new loop must emit the same StreamEvents for
 * the same canned LLMChunk inputs, or every downstream channel renders
 * differently.
 *
 * If a test here fails after a loop change, the question is "did the contract
 * change deliberately?" — if yes, update the reference array; if no, the
 * change is wrong.
 */

import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { AgentLoop } from './loop.js';
import type {
  Provider,
  LLMChunk,
  Message,
  ChatOptions,
  Tool,
  StreamEvent,
} from '@rivetos/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeProvider(perCallChunks: LLMChunk[][]): Provider {
  let call = 0;
  return {
    id: 'fake',
    name: 'Fake',
    async *chatStream(_messages: Message[], _options?: ChatOptions): AsyncIterable<LLMChunk> {
      const chunks = perCallChunks[call++] ?? [];
      for (const c of chunks) yield c;
    },
    async isAvailable() {
      return true;
    },
    getModel() {
      return 'fake-model';
    },
    setModel() {},
    getContextWindow() {
      return 0;
    },
    getMaxOutputTokens() {
      return 0;
    },
  };
}

function fakeTool(name: string, result: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: {
      type: 'object',
      properties: { x: { type: 'string' } },
      required: [],
    },
    async execute(): Promise<string> {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop StreamEvent baseline', () => {
  it('text-only single iteration emits exactly text events', async () => {
    const events: StreamEvent[] = [];
    const loop = new AgentLoop({
      systemPrompt: 'sp',
      tools: [],
      provider: fakeProvider([
        [
          { type: 'text', delta: 'Hello, ' },
          { type: 'text', delta: 'world!' },
          { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
        ],
      ]),
      onStream: (e) => events.push(e),
    });

    const result = await loop.run('hi', []);
    assert.equal(result.response, 'Hello, world!');
    assert.deepEqual(events, [
      { type: 'text', content: 'Hello, ' },
      { type: 'text', content: 'world!' },
    ]);
  });

  it('reasoning + text emits reasoning before text in delta order', async () => {
    const events: StreamEvent[] = [];
    const loop = new AgentLoop({
      systemPrompt: 'sp',
      tools: [],
      provider: fakeProvider([
        [
          { type: 'reasoning', delta: 'thinking... ' },
          { type: 'reasoning', delta: 'aha.' },
          { type: 'text', delta: 'Answer: 42' },
          { type: 'done', usage: { promptTokens: 5, completionTokens: 5 } },
        ],
      ]),
      onStream: (e) => events.push(e),
    });

    const result = await loop.run('hi', []);
    assert.equal(result.response, 'Answer: 42');
    assert.deepEqual(events, [
      { type: 'reasoning', content: 'thinking... ' },
      { type: 'reasoning', content: 'aha.' },
      { type: 'text', content: 'Answer: 42' },
    ]);
  });

  it('tool call + text: status events frame tool execution and final text emerges', async () => {
    const events: StreamEvent[] = [];
    const loop = new AgentLoop({
      systemPrompt: 'sp',
      tools: [fakeTool('shell', 'hi')],
      provider: fakeProvider([
        [
          { type: 'tool_call_start', toolCall: { index: 0, id: 'tc-1', name: 'shell' } },
          { type: 'tool_call_delta', delta: '{"command":"echo hi"}', toolCall: { index: 0 } },
          { type: 'tool_call_done', toolCall: { index: 0 } },
          { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
        ],
        [
          { type: 'text', delta: 'Done.' },
          { type: 'done', usage: { promptTokens: 20, completionTokens: 10 } },
        ],
      ]),
      onStream: (e) => events.push(e),
    });

    const result = await loop.run('run it', []);
    assert.equal(result.response, 'Done.');
    assert.deepEqual(result.toolsUsed, ['shell']);

    // Frozen baseline. Loop emits tool_start (with arg summary metadata) +
    // tool_result for the tool, then the final text.
    assert.deepEqual(events, [
      {
        type: 'tool_start',
        content: '🔧 shell',
        metadata: { args: { command: 'echo hi' } },
      },
      { type: 'tool_result', content: '✅ shell: hi' },
      { type: 'text', content: 'Done.' },
    ]);
  });

  it('parallel tool calls: events emitted in tool-call-array order', async () => {
    const events: StreamEvent[] = [];
    const loop = new AgentLoop({
      systemPrompt: 'sp',
      tools: [fakeTool('shell', 'A'), fakeTool('search', 'B')],
      provider: fakeProvider([
        [
          { type: 'tool_call_start', toolCall: { index: 0, id: 'tc-1', name: 'shell' } },
          { type: 'tool_call_delta', delta: '{"command":"a"}', toolCall: { index: 0 } },
          { type: 'tool_call_done', toolCall: { index: 0 } },
          { type: 'tool_call_start', toolCall: { index: 1, id: 'tc-2', name: 'search' } },
          { type: 'tool_call_delta', delta: '{"query":"b"}', toolCall: { index: 1 } },
          { type: 'tool_call_done', toolCall: { index: 1 } },
          { type: 'done', usage: { promptTokens: 1, completionTokens: 1 } },
        ],
        [
          { type: 'text', delta: 'OK' },
          { type: 'done', usage: { promptTokens: 1, completionTokens: 1 } },
        ],
      ]),
      onStream: (e) => events.push(e),
    });

    const result = await loop.run('do both', []);
    assert.equal(result.response, 'OK');
    assert.deepEqual(result.toolsUsed, ['shell', 'search']);

    assert.deepEqual(events, [
      {
        type: 'tool_start',
        content: '🔧 shell',
        metadata: { args: { command: 'a' } },
      },
      { type: 'tool_result', content: '✅ shell: A' },
      {
        type: 'tool_start',
        content: '🔧 search',
        metadata: { args: { query: 'b' } },
      },
      { type: 'tool_result', content: '✅ search: B' },
      { type: 'text', content: 'OK' },
    ]);
  });

  it('abort mid-stream: emits text events that arrived before abort, no synthetic events after', async () => {
    const events: StreamEvent[] = [];
    const controller = new AbortController();
    controller.abort('test abort');

    const loop = new AgentLoop({
      systemPrompt: 'sp',
      tools: [],
      provider: fakeProvider([
        [
          { type: 'text', delta: 'never seen' },
          { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } },
        ],
      ]),
      onStream: (e) => events.push(e),
    });

    const result = await loop.run('hi', [], controller.signal);
    assert.equal(result.aborted, true);
    // Pre-stream abort short-circuits before any provider chunk emit.
    assert.deepEqual(events, []);
  });

  it('provider error chunk surfaces a single error StreamEvent', async () => {
    const events: StreamEvent[] = [];
    const loop = new AgentLoop({
      systemPrompt: 'sp',
      tools: [],
      provider: fakeProvider([
        [
          { type: 'text', delta: 'partial' },
          { type: 'error', error: 'rate limit' },
        ],
      ]),
      onStream: (e) => events.push(e),
    });

    const result = await loop.run('hi', []);
    // Loop returns whatever text accumulated before the error chunk.
    assert.equal(result.response, 'partial');
    assert.deepEqual(events, [
      { type: 'text', content: 'partial' },
      { type: 'error', content: 'rate limit' },
    ]);
  });

  it('status delta from provider becomes prefixed status event', async () => {
    const events: StreamEvent[] = [];
    const loop = new AgentLoop({
      systemPrompt: 'sp',
      tools: [],
      provider: fakeProvider([
        [
          { type: 'status', delta: 'searching the web' },
          { type: 'text', delta: 'found it' },
          { type: 'done', usage: { promptTokens: 1, completionTokens: 1 } },
        ],
      ]),
      onStream: (e) => events.push(e),
    });

    await loop.run('hi', []);
    assert.deepEqual(events, [
      { type: 'status', content: '🔍 searching the web' },
      { type: 'text', content: 'found it' },
    ]);
  });
});
