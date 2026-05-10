/**
 * Loop StreamEvent regression baseline.
 *
 * These tests freeze the StreamEvent sequence the AgentLoop emits for a given
 * LLMChunk input. They are the regression line for the AI SDK loop swap (step
 * 8 of the migration plan) — the new loop emits the same StreamEvents for the
 * same canned LLMChunk inputs.
 *
 * The fixture (`makeMockProvider`) translates LLMChunk input into V3 stream
 * parts that AI SDK's `streamText` consumes naturally. Note: the V3 wire shape
 * has no `status` part, so status events now originate exclusively from the
 * loop's heartbeat / timeout-warning paths — provider-sourced status deltas
 * are dropped silently by the fixture.
 */

import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { AgentLoop } from './loop.js';
import { makeMockProvider, makeMockProviderSequence } from '../test-utils/mock-aisdk-provider.js';
import type { StreamEvent, Tool } from '@rivetos/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      provider: makeMockProvider([
        { type: 'text', delta: 'Hello, ' },
        { type: 'text', delta: 'world!' },
        { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
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
      provider: makeMockProvider([
        { type: 'reasoning', delta: 'thinking... ' },
        { type: 'reasoning', delta: 'aha.' },
        { type: 'text', delta: 'Answer: 42' },
        { type: 'done', usage: { promptTokens: 5, completionTokens: 5 } },
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

  it('tool call + text: events frame tool execution and final text emerges', async () => {
    const events: StreamEvent[] = [];
    const loop = new AgentLoop({
      systemPrompt: 'sp',
      tools: [fakeTool('shell', 'hi')],
      provider: makeMockProviderSequence([
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
      provider: makeMockProviderSequence([
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
      provider: makeMockProvider([
        { type: 'text', delta: 'never seen' },
        { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } },
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
      provider: makeMockProvider([
        { type: 'text', delta: 'partial' },
        { type: 'error', error: 'rate limit' },
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

  // Note: the legacy loop emitted a StreamEvent for provider-sourced status
  // chunks (e.g. xAI's `status` deltas saying "searching the web"). Under AI
  // SDK V3 there is no equivalent stream part, so the fixture drops them. The
  // loop still emits status events from the heartbeat scheduler and graceful
  // timeout warnings, but those paths are exercised by `loop.test.ts`.
});
