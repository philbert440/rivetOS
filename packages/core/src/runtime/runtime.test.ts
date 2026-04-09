/**
 * Runtime integration tests — full turn lifecycle.
 *
 * Tests the complete message path: channel receives message → router picks
 * agent/provider → agent loop runs → tools execute → response delivered →
 * memory appended.
 *
 * Uses mock implementations of Provider, Channel, Memory, and Tool.
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import * as assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from './runtime.js';
import { SILENT_RESPONSES } from '../domain/constants.js';
import type {
  Provider,
  Channel,
  Memory,
  Tool,
  InboundMessage,
  OutboundMessage,
  LLMChunk,
  Message,
  ChatOptions,
  MemoryEntry,
  MemorySearchResult,
} from '@rivetos/types';

// ---------------------------------------------------------------------------
// Mock Provider
// ---------------------------------------------------------------------------

type ChunkFactory = (messages: Message[]) => LLMChunk[];

function makeProvider(id: string, chunksOrFactory: LLMChunk[] | ChunkFactory): Provider {
  return {
    id,
    name: `Mock ${id}`,
    async *chatStream(messages: Message[], _options?: ChatOptions): AsyncIterable<LLMChunk> {
      const chunks = typeof chunksOrFactory === 'function'
        ? chunksOrFactory(messages)
        : chunksOrFactory;
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    async isAvailable() {
      return true;
    },
    getModel() { return 'test-model'; },
    setModel(_model: string) {},
    getContextWindow() { return 0; },
    getMaxOutputTokens() { return 0; },
  };
}

// Provider that does tool call on first invocation, text on second
function makeToolThenTextProvider(id: string): Provider {
  let callCount = 0;
  return {
    id,
    name: `Mock ${id}`,
    async *chatStream(_messages: Message[], _options?: ChatOptions): AsyncIterable<LLMChunk> {
      callCount++;
      if (callCount === 1) {
        yield { type: 'tool_call_start', toolCall: { index: 0, id: 'tc-1', name: 'test_tool' } };
        yield { type: 'tool_call_delta', delta: '{"value":"hello"}', toolCall: { index: 0 } };
        yield { type: 'tool_call_done', toolCall: { index: 0 } };
        yield { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } };
      } else {
        yield { type: 'text', delta: 'Tool returned: hello' };
        yield { type: 'done', usage: { promptTokens: 20, completionTokens: 10 } };
      }
    },
    async isAvailable() {
      return true;
    },
    getModel() { return 'test-model'; },
    setModel(_model: string) {},
    getContextWindow() { return 0; },
    getMaxOutputTokens() { return 0; },
  };
}

// Slow provider for testing queue ordering
function makeSlowProvider(id: string, delayMs: number, response: string): Provider {
  return {
    id,
    name: `Mock ${id}`,
    async *chatStream(_messages: Message[], _options?: ChatOptions): AsyncIterable<LLMChunk> {
      await new Promise((r) => setTimeout(r, delayMs));
      yield { type: 'text', delta: response };
      yield { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } };
    },
    async isAvailable() {
      return true;
    },
    getModel() { return 'test-model'; },
    setModel(_model: string) {},
    getContextWindow() { return 0; },
    getMaxOutputTokens() { return 0; },
  };
}

// ---------------------------------------------------------------------------
// Mock Channel
// ---------------------------------------------------------------------------

interface SentMessage {
  channelId: string;
  text?: string;
  replyToMessageId?: string;
}

function makeChannel(id: string): Channel & {
  sent: SentMessage[];
  reactions: Array<{ channelId: string; messageId: string; emoji: string }>;
  triggerMessage: (msg: InboundMessage) => Promise<void>;
  triggerCommand: (command: string, args: string, msg: InboundMessage) => Promise<void>;
} {
  let messageHandler: ((message: InboundMessage) => Promise<void>) | null = null;
  let commandHandler: ((command: string, args: string, message: InboundMessage) => Promise<void>) | null = null;

  const sent: SentMessage[] = [];
  const reactions: Array<{ channelId: string; messageId: string; emoji: string }> = [];

  return {
    id,
    platform: 'test',
    sent,
    reactions,
    async start() {},
    async stop() {},
    async send(message: OutboundMessage): Promise<string | null> {
      sent.push({
        channelId: message.channelId,
        text: message.text,
        replyToMessageId: message.replyToMessageId,
      });
      return `msg-${sent.length}`;
    },
    async edit(_channelId: string, _messageId: string, _text: string): Promise<boolean> {
      return true;
    },
    async react(channelId: string, messageId: string, emoji: string): Promise<void> {
      reactions.push({ channelId, messageId, emoji });
    },
    onMessage(handler: (message: InboundMessage) => Promise<void>) {
      messageHandler = handler;
    },
    onCommand(handler: (command: string, args: string, message: InboundMessage) => Promise<void>) {
      commandHandler = handler;
    },
    async triggerMessage(msg: InboundMessage) {
      if (messageHandler) await messageHandler(msg);
    },
    async triggerCommand(command: string, args: string, msg: InboundMessage) {
      if (commandHandler) await commandHandler(command, args, msg);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Memory
// ---------------------------------------------------------------------------

function makeMemory(): Memory & { appended: MemoryEntry[] } {
  const appended: MemoryEntry[] = [];

  return {
    appended,
    async append(entry: MemoryEntry): Promise<string> {
      appended.push(entry);
      return `mem-${appended.length}`;
    },
    async search(_query: string, _options?: any): Promise<MemorySearchResult[]> {
      return [];
    },
    async getContextForTurn(_query: string, _agent: string): Promise<string> {
      return '';
    },
    async getSessionHistory(_sessionId: string): Promise<Message[]> {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Tool
// ---------------------------------------------------------------------------

function makeTool(name: string, result: string): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    async execute(_args: Record<string, unknown>): Promise<string> {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(text: string, overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    userId: 'user-1',
    channelId: 'chan-1',
    chatType: 'private',
    text,
    platform: 'test',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/** Wait for channel to have at least `count` messages (with timeout) */
async function waitForSent(channel: { sent: SentMessage[] }, count: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (channel.sent.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout: expected ${count} messages, got ${channel.sent.length}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Runtime Integration', () => {
  let workspaceDir: string;

  beforeAll(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'rivetos-test-'));
    // Create minimal workspace files
    await writeFile(join(workspaceDir, 'CORE.md'), '# Test Core');
    await writeFile(join(workspaceDir, 'WORKSPACE.md'), '# Test Workspace');
    await writeFile(join(workspaceDir, 'USER.md'), '# Test User');
    await writeFile(join(workspaceDir, 'MEMORY.md'), '# Test Memory');
    await mkdir(join(workspaceDir, 'memory'), { recursive: true });
  });

  afterAll(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('full turn — text response arrives at channel', async () => {
    const provider = makeProvider('test-provider', [
      { type: 'text', delta: 'Hello from the agent!' },
      { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);

    const channel = makeChannel('test-channel');

    const runtime = new Runtime({
      workspaceDir,
      defaultAgent: 'test-agent',
      agents: [{ id: 'test-agent', name: 'Test Agent', provider: 'test-provider' }],
    });

    runtime.registerProvider(provider);
    runtime.registerChannel(channel);
    await runtime.start();

    await channel.triggerMessage(makeMessage('Hi there'));
    await waitForSent(channel, 1);

    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].text, 'Hello from the agent!');
    assert.equal(channel.sent[0].channelId, 'chan-1');

    await runtime.stop();
  });

  it('full turn — tool calling and response', async () => {
    const provider = makeToolThenTextProvider('test-provider');
    const channel = makeChannel('test-channel');
    const tool = makeTool('test_tool', 'hello');

    const runtime = new Runtime({
      workspaceDir,
      defaultAgent: 'test-agent',
      agents: [{ id: 'test-agent', name: 'Test Agent', provider: 'test-provider' }],
    });

    runtime.registerProvider(provider);
    runtime.registerChannel(channel);
    runtime.registerTool(tool);
    await runtime.start();

    await channel.triggerMessage(makeMessage('Use the tool'));
    await waitForSent(channel, 1);

    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].text, 'Tool returned: hello');

    await runtime.stop();
  });

  it('message routing — routes to correct provider per agent', async () => {
    const providerA = makeProvider('provider-a', [
      { type: 'text', delta: 'Response from A' },
      { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);
    const providerB = makeProvider('provider-b', [
      { type: 'text', delta: 'Response from B' },
      { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);

    const channel = makeChannel('test-channel');

    const runtime = new Runtime({
      workspaceDir,
      defaultAgent: 'agent-a',
      agents: [
        { id: 'agent-a', name: 'Agent A', provider: 'provider-a' },
        { id: 'agent-b', name: 'Agent B', provider: 'provider-b' },
      ],
    });

    runtime.registerProvider(providerA);
    runtime.registerProvider(providerB);
    runtime.registerChannel(channel);
    await runtime.start();

    // Default agent routes to provider-a
    await channel.triggerMessage(makeMessage('Hello'));
    await waitForSent(channel, 1);

    assert.equal(channel.sent[0].text, 'Response from A');

    // Explicit agent routes to provider-b
    await channel.triggerMessage(makeMessage('Hello', {
      id: 'msg-2',
      userId: 'user-2',
      agent: 'agent-b',
    }));
    await waitForSent(channel, 2);

    assert.equal(channel.sent[1].text, 'Response from B');

    await runtime.stop();
  });

  it('memory append — both user and assistant messages are recorded', async () => {
    const provider = makeProvider('test-provider', [
      { type: 'text', delta: 'Remembered response' },
      { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);

    const channel = makeChannel('test-channel');
    const memory = makeMemory();

    const runtime = new Runtime({
      workspaceDir,
      defaultAgent: 'test-agent',
      agents: [{ id: 'test-agent', name: 'Test Agent', provider: 'test-provider' }],
    });

    runtime.registerProvider(provider);
    runtime.registerChannel(channel);
    runtime.registerMemory(memory);
    await runtime.start();

    await channel.triggerMessage(makeMessage('Remember this'));
    await waitForSent(channel, 1);

    // Wait a tick for memory append (happens after send)
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(memory.appended.length >= 2, `Expected at least 2 memory entries, got ${memory.appended.length}`);

    const userEntry = memory.appended.find((e) => e.role === 'user');
    const assistantEntry = memory.appended.find((e) => e.role === 'assistant');

    assert.ok(userEntry, 'User message should be appended to memory');
    assert.equal(userEntry!.content, 'Remember this');
    assert.equal(userEntry!.agent, 'test-agent');

    assert.ok(assistantEntry, 'Assistant response should be appended to memory');
    assert.equal(assistantEntry!.content, 'Remembered response');
    assert.equal(assistantEntry!.agent, 'test-agent');

    await runtime.stop();
  });

  it('silent response — HEARTBEAT_OK is not sent to channel', async () => {
    const provider = makeProvider('test-provider', [
      { type: 'text', delta: 'HEARTBEAT_OK' },
      { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } },
    ]);

    const channel = makeChannel('test-channel');

    const runtime = new Runtime({
      workspaceDir,
      defaultAgent: 'test-agent',
      agents: [{ id: 'test-agent', name: 'Test Agent', provider: 'test-provider' }],
    });

    runtime.registerProvider(provider);
    runtime.registerChannel(channel);
    await runtime.start();

    await channel.triggerMessage(makeMessage('heartbeat check'));

    // Give it time to process
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(channel.sent.length, 0, 'Silent response should not be sent to channel');

    await runtime.stop();
  });

  it('queue behavior — messages processed sequentially', async () => {
    const responses: string[] = [];
    let callCount = 0;

    // Provider that takes 200ms to respond, returns different text each time
    const provider: Provider = {
      id: 'slow-provider',
      name: 'Slow Provider',
      async *chatStream(_messages: Message[], _options?: ChatOptions): AsyncIterable<LLMChunk> {
        callCount++;
        const myCount = callCount;
        await new Promise((r) => setTimeout(r, 200));
        responses.push(`response-${myCount}`);
        yield { type: 'text', delta: `response-${myCount}` };
        yield { type: 'done', usage: { promptTokens: 10, completionTokens: 5 } };
      },
      async isAvailable() {
        return true;
      },
      getModel() { return 'test-model'; },
      setModel(_model: string) {},
      getContextWindow() { return 0; },
      getMaxOutputTokens() { return 0; },
    };

    const channel = makeChannel('test-channel');

    const runtime = new Runtime({
      workspaceDir,
      defaultAgent: 'test-agent',
      agents: [{ id: 'test-agent', name: 'Test Agent', provider: 'slow-provider' }],
    });

    runtime.registerProvider(provider);
    runtime.registerChannel(channel);
    await runtime.start();

    // Fire two messages from the same user quickly
    const msg1 = makeMessage('First');
    const msg2 = makeMessage('Second');

    // Don't await — fire both nearly simultaneously
    channel.triggerMessage(msg1);
    await new Promise((r) => setTimeout(r, 20));
    channel.triggerMessage(msg2);

    await waitForSent(channel, 2, 10000);

    // Verify sequential processing
    assert.equal(responses[0], 'response-1');
    assert.equal(responses[1], 'response-2');
    assert.equal(channel.sent[0].text, 'response-1');
    assert.equal(channel.sent[1].text, 'response-2');

    await runtime.stop();
  });
});
