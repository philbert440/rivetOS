/**
 * AgentLoop tests — text response, tool calling, abort, steer, max iterations,
 * error surfacing, and provider timeout handling.
 */

import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { AgentLoop } from './loop.js';
import type { Provider, LLMChunk, Message, ChatOptions, Tool } from '@rivetos/types';

// ---------------------------------------------------------------------------
// Mock provider — yields configurable chunks
// ---------------------------------------------------------------------------

function makeProvider(chunks: LLMChunk[]): Provider {
  return {
    id: 'mock',
    name: 'Mock Provider',
    async *chatStream(_messages: Message[], _options?: ChatOptions): AsyncIterable<LLMChunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    async isAvailable() {
      return true;
    },
  };
}

// Provider that returns text on second call (after tool result)
function makeToolThenTextProvider(): Provider {
  let callCount = 0;
  return {
    id: 'mock',
    name: 'Mock Provider',
    async *chatStream(_messages: Message[], _options?: ChatOptions): AsyncIterable<LLMChunk> {
      callCount++;
      if (callCount === 1) {
        // First call: request a tool call
        yield { type: 'tool_call_start', toolCall: { index: 0, id: 'tc-1', name: 'shell' } };
        yield { type: 'tool_call_delta', delta: '{"command":"echo hi"}', toolCall: { index: 0 } };
        yield { type: 'tool_call_done', toolCall: { index: 0 } };
        yield { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } };
      } else {
        // Second call: return text
        yield { type: 'text', delta: 'Done! The output was hi.' };
        yield { type: 'done', usage: { promptTokens: 20, completionTokens: 10 } };
      }
    },
    async isAvailable() {
      return true;
    },
  };
}

function makeTool(name: string, result: string): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    async execute(_args: Record<string, unknown>, _signal?: AbortSignal): Promise<string> {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop', () => {
  it('should return text response from provider', async () => {
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeProvider([
        { type: 'text', delta: 'Hello, ' },
        { type: 'text', delta: 'world!' },
        { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
      ]),
      tools: [],
    });

    const result = await loop.run('Hi', []);
    assert.equal(result.response, 'Hello, world!');
    assert.equal(result.aborted, false);
    assert.equal(result.iterations, 0);
    assert.deepEqual(result.toolsUsed, []);
  });

  it('should execute tool calls and loop back', async () => {
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeToolThenTextProvider(),
      tools: [makeTool('shell', 'hi')],
    });

    const result = await loop.run('Run echo hi', []);
    assert.equal(result.response, 'Done! The output was hi.');
    assert.equal(result.aborted, false);
    assert.equal(result.iterations, 1);
    assert.deepEqual(result.toolsUsed, ['shell']);
  });

  it('should abort on signal', async () => {
    const controller = new AbortController();
    // Abort immediately
    controller.abort('test abort');

    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeProvider([
        { type: 'text', delta: 'This should not complete' },
        { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } },
      ]),
      tools: [],
    });

    const result = await loop.run('Hi', [], controller.signal);
    assert.equal(result.aborted, true);
    assert.equal(result.response, '');
  });

  it('should inject steer message into conversation', async () => {
    const messagesReceived: Message[][] = [];
    let callCount = 0;

    const steerProvider: Provider = {
      id: 'mock',
      name: 'Mock',
      async *chatStream(messages: Message[], _options?: ChatOptions): AsyncIterable<LLMChunk> {
        callCount++;
        messagesReceived.push([...messages]);

        if (callCount === 1) {
          // Return a tool call to trigger another iteration
          yield { type: 'tool_call_start', toolCall: { index: 0, id: 'tc-1', name: 'shell' } };
          yield { type: 'tool_call_delta', delta: '{"command":"ls"}', toolCall: { index: 0 } };
          yield { type: 'tool_call_done', toolCall: { index: 0 } };
          yield { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } };
        } else {
          yield { type: 'text', delta: 'OK' };
          yield { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } };
        }
      },
      async isAvailable() { return true; },
    };

    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: steerProvider,
      tools: [makeTool('shell', 'file.txt')],
    });

    // Inject steer before the second iteration
    loop.steer('Actually, use the -la flag');

    const result = await loop.run('List files', []);
    assert.equal(result.response, 'OK');

    // The steer message should appear in the second call's messages
    const secondCallMessages = messagesReceived[1];
    assert.ok(secondCallMessages);
    const steerMsg = secondCallMessages.find((m) => m.content.includes('STEER'));
    assert.ok(steerMsg, 'Steer message should be injected');
    assert.ok(steerMsg.content.includes('Actually, use the -la flag'));
  });

  it('should stop at max iterations', async () => {
    // Provider always returns tool calls
    let callCount = 0;
    const infiniteToolProvider: Provider = {
      id: 'mock',
      name: 'Mock',
      async *chatStream(_messages: Message[], _options?: ChatOptions): AsyncIterable<LLMChunk> {
        callCount++;
        yield { type: 'tool_call_start', toolCall: { index: 0, id: `tc-${callCount}`, name: 'shell' } };
        yield { type: 'tool_call_delta', delta: '{"command":"echo loop"}', toolCall: { index: 0 } };
        yield { type: 'tool_call_done', toolCall: { index: 0 } };
        yield { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } };
      },
      async isAvailable() { return true; },
    };

    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: infiniteToolProvider,
      tools: [makeTool('shell', 'loop')],
      maxIterations: 3,
    });

    const result = await loop.run('Loop forever', []);
    assert.equal(result.iterations, 15); // hardCap = maxIterations * 5 = 15
    assert.ok(result.response.includes('safety cap'));
  });

  it('should accumulate token usage across iterations', async () => {
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeToolThenTextProvider(),
      tools: [makeTool('shell', 'hi')],
    });

    const result = await loop.run('Run echo hi', []);
    assert.ok(result.usage);
    assert.equal(result.usage.promptTokens, 40);  // 10+10 + 20+20 (Math.max + done accumulation)
    assert.equal(result.usage.completionTokens, 20);  // 5+5 + 10+10 (Math.max + done accumulation)
  });

  it('should handle unknown tool gracefully', async () => {
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeToolThenTextProvider(),
      tools: [],  // No tools registered
    });

    const result = await loop.run('Run something', []);
    assert.ok(result.toolsUsed.includes('shell'));
    // Should still complete (unknown tool returns error string, loop continues)
    assert.equal(result.aborted, false);
  });

  it('should emit stream events', async () => {
    const events: Array<{ type: string }> = [];

    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeProvider([
        { type: 'text', delta: 'Hello' },
        { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } },
      ]),
      tools: [],
      onStream: (event) => events.push(event),
    });

    await loop.run('Hi', []);
    assert.ok(events.some((e) => e.type === 'text'));
  });

  it('should surface provider error as response when no text produced', async () => {
    const events: Array<{ type: string; content?: string }> = [];
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeProvider([
        { type: 'error', error: 'Provider timed out waiting for first response (120s). The model may be overloaded or the context too large.' },
      ]),
      tools: [],
      onStream: (event) => events.push(event),
    });

    const result = await loop.run('Hi', []);
    // Should NOT return empty string — error is surfaced as response
    assert.ok(result.response.includes('timed out'), `Expected error in response, got: "${result.response}"`);
    assert.ok(result.response.startsWith('⚠️'), 'Error response should start with warning emoji');
    assert.equal(result.aborted, false);
    // Error event should also have been emitted
    assert.ok(events.some((e) => e.type === 'error'));
  });

  it('should prefer text content over error when both exist', async () => {
    const loop = new AgentLoop({
      systemPrompt: 'You are helpful.',
      provider: makeProvider([
        { type: 'text', delta: 'Partial response before error' },
        { type: 'error', error: 'Something went wrong' },
      ]),
      tools: [],
    });

    const result = await loop.run('Hi', []);
    // Text content takes priority — error was already emitted as event
    assert.equal(result.response, 'Partial response before error');
  });
});
