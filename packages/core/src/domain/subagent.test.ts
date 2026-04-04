/**
 * Tests for SubagentManager — child agent session orchestration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubagentManagerImpl, createSubagentTools, type SubagentManagerConfig } from './subagent.js';
import type { Router } from './router.js';
import type { WorkspaceLoader } from './workspace.js';
import type { Tool, SubagentSpawnRequest } from '@rivetos/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockRouter(agents: Array<{ id: string; provider: string }> = []): Router {
  const mockAgents = agents.map((a) => ({
    id: a.id,
    name: a.id,
    provider: a.provider,
  }));

  const mockProviders = [...new Set(agents.map((a) => a.provider))].map((p) => ({
    id: p,
    chatStream: vi.fn(async function* () {
      yield { type: 'text' as const, delta: `Response from ${p}` };
      yield { type: 'done' as const, usage: { promptTokens: 5, completionTokens: 10 } };
    }),
    healthCheck: vi.fn(async () => true),
  }));

  return {
    getAgents: () => mockAgents as any[],
    getProviders: () => mockProviders as any[],
    registerAgent: vi.fn(),
    registerProvider: vi.fn(),
    route: vi.fn(),
    healthCheck: vi.fn(),
  } as unknown as Router;
}

function createMockWorkspace(): WorkspaceLoader {
  return {
    buildSystemPrompt: vi.fn(async (agentId: string) => `System prompt for ${agentId}`),
    load: vi.fn(async () => []),
    buildHeartbeatPrompt: vi.fn(async () => 'heartbeat'),
  } as unknown as WorkspaceLoader;
}

function createConfig(
  agents: Array<{ id: string; provider: string }> = [
    { id: 'grok', provider: 'xai' },
    { id: 'opus', provider: 'anthropic' },
  ],
): SubagentManagerConfig {
  return {
    router: createMockRouter(agents),
    workspace: createMockWorkspace(),
    tools: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubagentManagerImpl', () => {
  describe('spawn — run mode', () => {
    it('spawns a one-shot subagent and returns completed session', async () => {
      const manager = new SubagentManagerImpl(createConfig());
      const session = await manager.spawn({
        agent: 'grok',
        task: 'Write a test',
        mode: 'run',
      });

      expect(session.status).toBe('completed');
      expect(session.childAgent).toBe('grok');
      expect(session.history).toHaveLength(2); // user + assistant
      expect(session.history[0].role).toBe('user');
      expect(session.history[1].role).toBe('assistant');
    });

    it('throws on unknown agent', async () => {
      const manager = new SubagentManagerImpl(createConfig());
      await expect(
        manager.spawn({ agent: 'nonexistent', task: 'test', mode: 'run' }),
      ).rejects.toThrow('Unknown agent');
    });

    it('throws on missing provider', async () => {
      const router = createMockRouter([{ id: 'grok', provider: 'xai' }]);
      // Add an agent whose provider isn't registered
      (router.getAgents() as any[]).push({ id: 'broken', name: 'broken', provider: 'ghost' });
      const config: SubagentManagerConfig = {
        router,
        workspace: createMockWorkspace(),
        tools: [],
      };
      const manager = new SubagentManagerImpl(config);
      await expect(
        manager.spawn({ agent: 'broken', task: 'test', mode: 'run' }),
      ).rejects.toThrow('Provider');
    });

    it('run mode session is cleaned up after completion', async () => {
      const manager = new SubagentManagerImpl(createConfig());
      await manager.spawn({ agent: 'grok', task: 'test', mode: 'run' });

      // Session should be cleaned up (not listed)
      expect(manager.list()).toHaveLength(0);
    });
  });

  describe('spawn — session mode', () => {
    it('spawns a persistent session and keeps it alive', async () => {
      const manager = new SubagentManagerImpl(createConfig());
      const session = await manager.spawn({
        agent: 'grok',
        task: 'Start a conversation',
        mode: 'session',
      });

      expect(session.status).toBe('running');
      expect(session.childAgent).toBe('grok');
      expect(session.history).toHaveLength(2);
    });

    it('session appears in list()', async () => {
      const manager = new SubagentManagerImpl(createConfig());
      const session = await manager.spawn({
        agent: 'grok',
        task: 'Start',
        mode: 'session',
      });

      const listed = manager.list();
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe(session.id);
    });
  });

  describe('send', () => {
    it('sends a follow-up message to a session', async () => {
      const manager = new SubagentManagerImpl(createConfig());
      const session = await manager.spawn({
        agent: 'grok',
        task: 'Start',
        mode: 'session',
      });

      const response = await manager.send(session.id, 'Follow up');
      expect(typeof response).toBe('string');
    });

    it('throws on unknown session ID', async () => {
      const manager = new SubagentManagerImpl(createConfig());
      await expect(manager.send('bad-id', 'hello')).rejects.toThrow('not found');
    });

    it('throws on completed session', async () => {
      const manager = new SubagentManagerImpl(createConfig());
      const session = await manager.spawn({
        agent: 'grok',
        task: 'test',
        mode: 'run',
      });

      // run mode auto-cleans, so session won't be found
      await expect(manager.send(session.id, 'hello')).rejects.toThrow('not found');
    });
  });

  describe('yield', () => {
    it('yields a running session', async () => {
      const manager = new SubagentManagerImpl(createConfig());
      const session = await manager.spawn({
        agent: 'grok',
        task: 'Start',
        mode: 'session',
      });

      manager.yield(session.id, 'Pausing for now');

      const listed = manager.list();
      expect(listed[0].status).toBe('yielded');
    });

    it('throws on unknown session', () => {
      const manager = new SubagentManagerImpl(createConfig());
      expect(() => manager.yield('bad-id')).toThrow('not found');
    });
  });

  describe('kill', () => {
    it('kills a running session', async () => {
      const manager = new SubagentManagerImpl(createConfig());
      const session = await manager.spawn({
        agent: 'grok',
        task: 'Start',
        mode: 'session',
      });

      manager.kill(session.id);
      expect(manager.list()).toHaveLength(0);
    });

    it('throws on unknown session', () => {
      const manager = new SubagentManagerImpl(createConfig());
      expect(() => manager.kill('bad-id')).toThrow('not found');
    });
  });

  describe('list', () => {
    it('returns only running and yielded sessions', async () => {
      const manager = new SubagentManagerImpl(createConfig());

      const s1 = await manager.spawn({ agent: 'grok', task: 'A', mode: 'session' });
      const s2 = await manager.spawn({ agent: 'opus', task: 'B', mode: 'session' });
      manager.yield(s2.id);

      const listed = manager.list();
      expect(listed).toHaveLength(2);
      expect(listed.find((s) => s.id === s1.id)?.status).toBe('running');
      expect(listed.find((s) => s.id === s2.id)?.status).toBe('yielded');
    });
  });
});

describe('createSubagentTools', () => {
  it('creates 4 tools', () => {
    const manager = new SubagentManagerImpl(createConfig());
    const tools = createSubagentTools(manager);

    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain('subagent_spawn');
    expect(names).toContain('subagent_send');
    expect(names).toContain('subagent_list');
    expect(names).toContain('subagent_kill');
  });

  it('spawn tool returns response in run mode', async () => {
    const manager = new SubagentManagerImpl(createConfig());
    const tools = createSubagentTools(manager);
    const spawnTool = tools.find((t) => t.name === 'subagent_spawn')!;

    const result = await spawnTool.execute({
      agent: 'grok',
      task: 'Do something',
      mode: 'run',
    });

    expect(typeof result).toBe('string');
    expect(result).toContain('Response from');
  });

  it('spawn tool returns session ID in session mode', async () => {
    const manager = new SubagentManagerImpl(createConfig());
    const tools = createSubagentTools(manager);
    const spawnTool = tools.find((t) => t.name === 'subagent_spawn')!;

    const result = await spawnTool.execute({
      agent: 'grok',
      task: 'Start session',
      mode: 'session',
    });

    const parsed = JSON.parse(result as string);
    expect(parsed.sessionId).toBeDefined();
    expect(parsed.agent).toBe('grok');
  });

  it('spawn tool handles errors gracefully', async () => {
    const manager = new SubagentManagerImpl(createConfig());
    const tools = createSubagentTools(manager);
    const spawnTool = tools.find((t) => t.name === 'subagent_spawn')!;

    const result = await spawnTool.execute({
      agent: 'nonexistent',
      task: 'test',
      mode: 'run',
    });

    expect(result).toContain('Error');
  });

  it('list tool returns empty when no sessions', async () => {
    const manager = new SubagentManagerImpl(createConfig());
    const tools = createSubagentTools(manager);
    const listTool = tools.find((t) => t.name === 'subagent_list')!;

    const result = await listTool.execute({});
    expect(result).toContain('No active');
  });

  it('kill tool handles unknown session', async () => {
    const manager = new SubagentManagerImpl(createConfig());
    const tools = createSubagentTools(manager);
    const killTool = tools.find((t) => t.name === 'subagent_kill')!;

    const result = await killTool.execute({ session_id: 'bad-id' });
    expect(result).toContain('Error');
  });
});
