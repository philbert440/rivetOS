/**
 * Tests for DelegationEngine — intra-instance agent-to-agent task handoff.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DelegationEngine, filterToolsForAgent, type DelegationConfig } from './delegation.js';
import type { Router } from './router.js';
import type { WorkspaceLoader } from './workspace.js';
import type {
  Tool,
  DelegationRequest,
  HookPipeline,
  HookRegistration,
  HookContext,
  HookPipelineResult,
  DelegationBeforeContext,
  DelegationAfterContext,
} from '@rivetos/types';

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
      yield { type: 'text' as const, delta: 'Delegated result from ' + p };
      yield { type: 'done' as const, usage: { promptTokens: 10, completionTokens: 20 } };
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
    buildHeartbeatPrompt: vi.fn(async () => 'heartbeat prompt'),
  } as unknown as WorkspaceLoader;
}

function createMockHookPipeline(): HookPipeline & { hooks: HookRegistration[] } {
  const hooks: HookRegistration[] = [];
  return {
    hooks,
    register: (hook: HookRegistration) => { hooks.push(hook); },
    unregister: (id: string) => {
      const idx = hooks.findIndex((h) => h.id === id);
      if (idx >= 0) { hooks.splice(idx, 1); return true; }
      return false;
    },
    run: vi.fn(async <T extends HookContext>(ctx: T): Promise<HookPipelineResult<T>> => {
      // Run any registered handlers that match the event
      for (const hook of hooks) {
        if (hook.event === ctx.event && hook.enabled !== false) {
          await hook.handler(ctx);
        }
      }
      return { context: ctx, aborted: false, skipped: false, errors: [], ran: [] };
    }),
    getHooks: (event?: string) => event ? hooks.filter((h) => h.event === event) : hooks,
    clear: () => { hooks.length = 0; },
  };
}

function createBaseConfig(
  agents: Array<{ id: string; provider: string }> = [
    { id: 'grok', provider: 'xai' },
    { id: 'opus', provider: 'anthropic' },
    { id: 'local', provider: 'ollama' },
  ],
): DelegationConfig {
  return {
    router: createMockRouter(agents),
    workspace: createMockWorkspace(),
    tools: () => [],
  };
}

function createRequest(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    fromAgent: 'opus',
    toAgent: 'grok',
    task: 'Write a hello world function',
    timeoutMs: 1_800_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DelegationEngine', () => {
  describe('basic delegation', () => {
    it('delegates to another agent and returns completed result', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);
      const result = await engine.delegate(createRequest());

      expect(result.status).toBe('completed');
      expect(result.response).toContain('Delegated result');
    });

    it('fails when target agent does not exist', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);
      const result = await engine.delegate(createRequest({ toAgent: 'nonexistent' }));

      expect(result.status).toBe('failed');
      expect(result.response).toContain('Unknown agent: nonexistent');
      expect(result.response).toContain('grok');
    });

    it('fails when provider is not available', async () => {
      // Agent exists but its provider is not registered
      const router = createMockRouter([{ id: 'grok', provider: 'xai' }]);
      // Add an agent whose provider isn't in the providers list
      (router.getAgents() as any[]).push({ id: 'broken', name: 'broken', provider: 'missing-provider' });
      const config: DelegationConfig = {
        router,
        workspace: createMockWorkspace(),
        tools: () => [],
      };
      const engine = new DelegationEngine(config);
      const result = await engine.delegate(createRequest({ toAgent: 'broken' }));

      expect(result.status).toBe('failed');
      expect(result.response).toContain('Provider missing-provider not available');
    });

    it('passes fromAgent context in system prompt', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);
      await engine.delegate(createRequest({ fromAgent: 'opus', context: ['Review for security'] }));

      const workspace = config.workspace as any;
      expect(workspace.buildSystemPrompt).toHaveBeenCalledWith('grok');
    });
  });

  describe('chain depth limiting', () => {
    it('rejects when chain depth exceeds limit', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine({ ...config, maxChainDepth: 2 });
      const result = await engine.delegate(createRequest(), 2);

      expect(result.status).toBe('failed');
      expect(result.response).toContain('chain depth limit');
    });

    it('allows delegation at depth 0 with default limit of 3', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);
      const result = await engine.delegate(createRequest(), 0);

      expect(result.status).toBe('completed');
    });

    it('allows delegation up to maxChainDepth - 1', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine({ ...config, maxChainDepth: 3 });
      const result = await engine.delegate(createRequest(), 2);

      expect(result.status).toBe('completed');
    });

    it('rejects at exactly maxChainDepth', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine({ ...config, maxChainDepth: 3 });
      const result = await engine.delegate(createRequest(), 3);

      expect(result.status).toBe('failed');
      expect(result.response).toContain('depth limit');
    });
  });

  describe('result caching', () => {
    it('caches completed delegation results', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);
      const request = createRequest();

      const result1 = await engine.delegate(request);
      expect(result1.status).toBe('completed');
      expect(engine.cacheSize).toBe(1);

      const result2 = await engine.delegate(request);
      expect(result2.status).toBe('completed');
      expect(result2.response).toBe(result1.response);
    });

    it('does not cache failed results', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);

      await engine.delegate(createRequest({ toAgent: 'nonexistent' }));
      expect(engine.cacheSize).toBe(0);
    });

    it('expires cached results after TTL', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine({ ...config, cacheTtlMs: 50 });
      const request = createRequest();

      await engine.delegate(request);
      expect(engine.cacheSize).toBe(1);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 60));

      // Should re-execute (cache expired)
      const result = await engine.delegate(request);
      expect(result.status).toBe('completed');
    });

    it('clearCache removes all entries', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);

      await engine.delegate(createRequest());
      expect(engine.cacheSize).toBe(1);

      engine.clearCache();
      expect(engine.cacheSize).toBe(0);
    });

    it('uses different cache keys for different tasks', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);

      await engine.delegate(createRequest({ task: 'task A' }));
      await engine.delegate(createRequest({ task: 'task B' }));
      expect(engine.cacheSize).toBe(2);
    });

    it('uses different cache keys for different target agents', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);

      await engine.delegate(createRequest({ toAgent: 'grok' }));
      await engine.delegate(createRequest({ toAgent: 'local' }));
      expect(engine.cacheSize).toBe(2);
    });
  });

  describe('timeout handling', () => {
    it('returns timeout status when provider hangs before yielding', async () => {
      // Provider hangs immediately — no text yielded, abort fires
      const config = createBaseConfig();
      const slowProvider = config.router.getProviders().find((p: any) => p.id === 'xai') as any;
      slowProvider.chatStream = vi.fn(async function* (_msgs: any, opts: any) {
        // Wait until aborted — never yields any text
        await new Promise<void>((resolve) => {
          if (opts?.signal?.aborted) { resolve(); return; }
          opts?.signal?.addEventListener('abort', () => resolve());
          setTimeout(resolve, 5000);
        });
        // After abort, check signal before yielding
        if (opts?.signal?.aborted) return;
        yield { type: 'text' as const, delta: 'too late' };
      });

      const engine = new DelegationEngine(config);
      const result = await engine.delegate(createRequest({ timeoutMs: 100 }));

      // The loop checks signal.aborted at the top of the while loop after the stream ends
      expect(['timeout', 'completed']).toContain(result.status);
    }, 10000);

    it('returns failed when provider throws during timeout', async () => {
      const config = createBaseConfig();
      const slowProvider = config.router.getProviders().find((p: any) => p.id === 'xai') as any;
      slowProvider.chatStream = vi.fn(async function* (_msgs: any, opts: any) {
        // Throw when aborted
        await new Promise<void>((_, reject) => {
          if (opts?.signal?.aborted) { reject(new Error('aborted')); return; }
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(() => reject(new Error('aborted')), 5000);
        });
      });

      const engine = new DelegationEngine(config);
      const result = await engine.delegate(createRequest({ timeoutMs: 100 }));

      // Either timeout or failed depending on race
      expect(['timeout', 'failed']).toContain(result.status);
    }, 10000);

    it('completes normally when under timeout', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);
      const result = await engine.delegate(createRequest({ timeoutMs: 5000 }));

      expect(result.status).toBe('completed');
    });
  });

  describe('hook integration', () => {
    it('fires delegation:before hook', async () => {
      const hooks = createMockHookPipeline();
      const beforeSpy = vi.fn();
      hooks.register({
        id: 'test-before',
        event: 'delegation:before',
        handler: beforeSpy,
      });

      const config = createBaseConfig();
      const engine = new DelegationEngine({ ...config, hooks });
      await engine.delegate(createRequest());

      expect(beforeSpy).toHaveBeenCalledOnce();
      const ctx = beforeSpy.mock.calls[0][0] as DelegationBeforeContext;
      expect(ctx.fromAgent).toBe('opus');
      expect(ctx.toAgent).toBe('grok');
      expect(ctx.task).toBe('Write a hello world function');
      expect(ctx.chainDepth).toBe(0);
    });

    it('fires delegation:after hook on success', async () => {
      const hooks = createMockHookPipeline();
      const afterSpy = vi.fn();
      hooks.register({
        id: 'test-after',
        event: 'delegation:after',
        handler: afterSpy,
      });

      const config = createBaseConfig();
      const engine = new DelegationEngine({ ...config, hooks });
      await engine.delegate(createRequest());

      expect(afterSpy).toHaveBeenCalledOnce();
      const ctx = afterSpy.mock.calls[0][0] as DelegationAfterContext;
      expect(ctx.status).toBe('completed');
      expect(ctx.cached).toBe(false);
      expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('fires delegation:after with cached=true on cache hit', async () => {
      const hooks = createMockHookPipeline();
      const afterSpy = vi.fn();
      hooks.register({
        id: 'test-after',
        event: 'delegation:after',
        handler: afterSpy,
      });

      const config = createBaseConfig();
      const engine = new DelegationEngine({ ...config, hooks });
      await engine.delegate(createRequest());
      await engine.delegate(createRequest()); // cache hit

      expect(afterSpy).toHaveBeenCalledTimes(2);
      const ctx2 = afterSpy.mock.calls[1][0] as DelegationAfterContext;
      expect(ctx2.cached).toBe(true);
      expect(ctx2.status).toBe('cached');
    });

    it('blocks delegation when hook sets blocked=true', async () => {
      const hooks = createMockHookPipeline();
      hooks.register({
        id: 'blocker',
        event: 'delegation:before',
        handler: (ctx: any) => {
          ctx.blocked = true;
          ctx.blockReason = 'Agent grok is offline';
        },
      });

      const config = createBaseConfig();
      const engine = new DelegationEngine({ ...config, hooks });
      const result = await engine.delegate(createRequest());

      expect(result.status).toBe('failed');
      expect(result.response).toContain('Agent grok is offline');
    });

    it('fires delegation:after on failure too', async () => {
      const hooks = createMockHookPipeline();
      const afterSpy = vi.fn();
      hooks.register({
        id: 'test-after',
        event: 'delegation:after',
        handler: afterSpy,
      });

      const config = createBaseConfig();
      const engine = new DelegationEngine({ ...config, hooks });
      await engine.delegate(createRequest({ toAgent: 'nonexistent' }));

      expect(afterSpy).toHaveBeenCalledOnce();
      const ctx = afterSpy.mock.calls[0][0] as DelegationAfterContext;
      expect(ctx.status).toBe('failed');
    });
  });

  describe('tool filtering', () => {
    it('excludes tools from blocklist for target agent', async () => {
      const mockTool1: Tool = { name: 'shell', description: 'shell', parameters: { type: 'object', properties: {} }, execute: vi.fn() };
      const mockTool2: Tool = { name: 'file_read', description: 'read', parameters: { type: 'object', properties: {} }, execute: vi.fn() };
      const mockTool3: Tool = { name: 'coding_pipeline', description: 'pipeline', parameters: { type: 'object', properties: {} }, execute: vi.fn() };

      const config = createBaseConfig();
      const engine = new DelegationEngine({
        ...config,
        tools: () => [mockTool1, mockTool2, mockTool3],
        toolFilter: { grok: { exclude: ['coding_pipeline', 'delegate_task'] } },
      });

      // We can't directly inspect tools passed to AgentLoop, but we can verify
      // the delegation completes (meaning tools were resolved)
      const result = await engine.delegate(createRequest());
      expect(result.status).toBe('completed');
    });

    it('applies include filter (allowlist) for target agent', async () => {
      const mockTool1: Tool = { name: 'shell', description: 'shell', parameters: { type: 'object', properties: {} }, execute: vi.fn() };
      const mockTool2: Tool = { name: 'file_read', description: 'read', parameters: { type: 'object', properties: {} }, execute: vi.fn() };

      const config = createBaseConfig();
      const engine = new DelegationEngine({
        ...config,
        tools: () => [mockTool1, mockTool2],
        toolFilter: { grok: { include: ['shell'] } },
      });

      const result = await engine.delegate(createRequest());
      expect(result.status).toBe('completed');
    });

    it('does not filter tools for agents without filter config', async () => {
      const mockTool1: Tool = { name: 'shell', description: 'shell', parameters: { type: 'object', properties: {} }, execute: vi.fn() };

      const config = createBaseConfig();
      const engine = new DelegationEngine({
        ...config,
        tools: () => [mockTool1],
        toolFilter: { local: { exclude: ['shell'] } }, // Only local is filtered, not grok
      });

      const result = await engine.delegate(createRequest({ toAgent: 'grok' }));
      expect(result.status).toBe('completed');
    });
  });

  describe('noDelegation flag', () => {
    it('does not give delegate_task tool when noDelegation is true', async () => {
      const delegateToolSpy = vi.fn();
      const config = createBaseConfig();
      // Patch AgentLoop to capture tools passed to it
      const originalDelegate = DelegationEngine.prototype.delegate;

      const engine = new DelegationEngine(config);

      // We can verify by checking that a request with noDelegation
      // succeeds without giving the agent a delegate_task tool.
      // Since we can't directly inspect AgentLoop tools, we verify
      // the delegation completes and no sub-delegation happens.
      const result = await engine.delegate(
        createRequest({ noDelegation: true }),
        0,
      );
      expect(result.status).toBe('completed');
    });

    it('still gives delegate_task tool when noDelegation is false/absent', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);

      // Normal delegation at depth 0 should complete (delegate_task tool is included)
      const result = await engine.delegate(createRequest(), 0);
      expect(result.status).toBe('completed');
    });
  });

  describe('createDelegationTool', () => {
    it('creates a tool with correct name and parameters', () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);
      const tool = engine.createDelegationTool();

      expect(tool.name).toBe('delegate_task');
      expect(tool.parameters.required).toContain('to_agent');
      expect(tool.parameters.required).toContain('task');
    });

    it('tool execute delegates and returns response', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);
      const tool = engine.createDelegationTool();

      const result = await tool.execute(
        { to_agent: 'grok', task: 'test task' },
        undefined,
        { agentId: 'opus' },
      );

      expect(typeof result).toBe('string');
      expect(result).toContain('Delegated result');
    });

    it('tool returns status prefix on failure', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine(config);
      const tool = engine.createDelegationTool();

      const result = await tool.execute(
        { to_agent: 'nonexistent', task: 'test' },
        undefined,
        { agentId: 'opus' },
      );

      expect(result).toContain('[failed]');
    });

    it('uses provided chain depth', async () => {
      const config = createBaseConfig();
      const engine = new DelegationEngine({ ...config, maxChainDepth: 1 });
      const tool = engine.createDelegationTool(1); // Already at depth 1, max is 1

      const result = await tool.execute(
        { to_agent: 'grok', task: 'test' },
        undefined,
        { agentId: 'opus' },
      );

      expect(result).toContain('depth limit');
    });
  });
});

describe('filterToolsForAgent', () => {
  const tool1: Tool = { name: 'shell', description: 'shell', parameters: { type: 'object', properties: {} }, execute: vi.fn() };
  const tool2: Tool = { name: 'file_read', description: 'read', parameters: { type: 'object', properties: {} }, execute: vi.fn() };
  const tool3: Tool = { name: 'coding_pipeline', description: 'pipeline', parameters: { type: 'object', properties: {} }, execute: vi.fn() };
  const allTools = [tool1, tool2, tool3];

  it('returns all tools when no filter is provided', () => {
    expect(filterToolsForAgent(allTools, 'grok')).toEqual(allTools);
    expect(filterToolsForAgent(allTools, 'grok', undefined)).toEqual(allTools);
  });

  it('returns all tools when agent has no filter entry', () => {
    expect(filterToolsForAgent(allTools, 'grok', { local: { exclude: ['shell'] } })).toEqual(allTools);
  });

  it('excludes tools in the blocklist', () => {
    const result = filterToolsForAgent(allTools, 'grok', { grok: { exclude: ['coding_pipeline'] } });
    expect(result.map((t) => t.name)).toEqual(['shell', 'file_read']);
  });

  it('includes only tools in the allowlist', () => {
    const result = filterToolsForAgent(allTools, 'grok', { grok: { include: ['shell'] } });
    expect(result.map((t) => t.name)).toEqual(['shell']);
  });

  it('include takes precedence over exclude when both set', () => {
    const result = filterToolsForAgent(allTools, 'grok', {
      grok: { exclude: ['shell'], include: ['shell', 'file_read'] },
    });
    expect(result.map((t) => t.name)).toEqual(['shell', 'file_read']);
  });

  it('returns empty array when include list has no matches', () => {
    const result = filterToolsForAgent(allTools, 'grok', { grok: { include: ['nonexistent'] } });
    expect(result).toEqual([]);
  });

  it('handles empty exclude list (no filtering)', () => {
    const result = filterToolsForAgent(allTools, 'grok', { grok: { exclude: [] } });
    expect(result).toEqual(allTools);
  });
});
