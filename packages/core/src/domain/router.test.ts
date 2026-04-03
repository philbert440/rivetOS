/**
 * Router tests — agent registration, provider lookup, routing, health check.
 */

import { describe, it, beforeEach } from 'vitest';
import * as assert from 'node:assert/strict';
import { Router } from './router.js';
import type { Provider, AgentConfig, InboundMessage, LLMChunk, Message, ChatOptions } from '@rivetos/types';

function makeProvider(id: string, available = true): Provider {
  return {
    id,
    name: `Provider ${id}`,
    async *chatStream(_messages: Message[], _options?: ChatOptions): AsyncIterable<LLMChunk> {
      yield { type: 'text', delta: 'hello' };
      yield { type: 'done', usage: { promptTokens: 0, completionTokens: 0 } };
    },
    async isAvailable() {
      return available;
    },
  };
}

function makeAgent(id: string, provider: string): AgentConfig {
  return { id, name: id, provider };
}

function makeMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: '1',
    userId: 'user-1',
    channelId: 'chan-1',
    chatType: 'private',
    text: 'test',
    platform: 'test',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('Router', () => {
  let router: Router;

  beforeEach(() => {
    router = new Router('default-agent');
    router.registerAgent(makeAgent('default-agent', 'anthropic'));
    router.registerAgent(makeAgent('fast-agent', 'xai'));
    router.registerProvider(makeProvider('anthropic'));
    router.registerProvider(makeProvider('xai'));
  });

  it('should route to the default agent when no agent specified', () => {
    const result = router.route(makeMessage());
    assert.equal(result.agent.id, 'default-agent');
    assert.equal(result.provider.id, 'anthropic');
  });

  it('should route to a specific agent when specified', () => {
    const result = router.route(makeMessage({ agent: 'fast-agent' }));
    assert.equal(result.agent.id, 'fast-agent');
    assert.equal(result.provider.id, 'xai');
  });

  it('should throw for unknown agent', () => {
    assert.throws(
      () => router.route(makeMessage({ agent: 'nonexistent' })),
      /Unknown agent: "nonexistent"/,
    );
  });

  it('should throw for agent with unregistered provider', () => {
    router.registerAgent(makeAgent('orphan-agent', 'missing-provider'));
    assert.throws(
      () => router.route(makeMessage({ agent: 'orphan-agent' })),
      /Unknown provider: "missing-provider"/,
    );
  });

  it('should list all registered agents', () => {
    const agents = router.getAgents();
    assert.equal(agents.length, 2);
    assert.ok(agents.some((a) => a.id === 'default-agent'));
    assert.ok(agents.some((a) => a.id === 'fast-agent'));
  });

  it('should list all registered providers', () => {
    const providers = router.getProviders();
    assert.equal(providers.length, 2);
  });

  it('should run health checks on all providers', async () => {
    const health = await router.healthCheck();
    assert.equal(health['anthropic'], true);
    assert.equal(health['xai'], true);
  });

  it('should report unavailable providers', async () => {
    const r = new Router('a');
    r.registerAgent(makeAgent('a', 'down'));
    r.registerProvider(makeProvider('down', false));

    const health = await r.healthCheck();
    assert.equal(health['down'], false);
  });
});
