/**
 * HookPipeline tests — priority ordering, data passing, short-circuit,
 * error modes (continue/abort/retry), agent/tool filters, async handlers.
 */

import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { HookPipelineImpl } from './hooks.js';
import type {
  ProviderBeforeContext,
  ProviderErrorContext,
  ToolBeforeContext,
  ToolAfterContext,
  TurnBeforeContext,
  HookRegistration,
  HookContext,
} from '@rivetos/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProviderBeforeCtx(overrides: Partial<ProviderBeforeContext> = {}): ProviderBeforeContext {
  return {
    event: 'provider:before',
    providerId: 'google',
    model: 'gemini-2.5-pro',
    messages: [],
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function makeToolBeforeCtx(overrides: Partial<ToolBeforeContext> = {}): ToolBeforeContext {
  return {
    event: 'tool:before',
    toolName: 'shell',
    args: { command: 'echo hi' },
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function makeTurnBeforeCtx(overrides: Partial<TurnBeforeContext> = {}): TurnBeforeContext {
  return {
    event: 'turn:before',
    userMessage: 'hello',
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HookPipeline', () => {
  // -----------------------------------------------------------------------
  // Basic execution
  // -----------------------------------------------------------------------

  it('should run hooks for matching event', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'hook-a',
      event: 'provider:before',
      handler: async () => { calls.push('a'); },
    });

    const ctx = makeProviderBeforeCtx();
    const result = await pipeline.run(ctx);

    assert.deepEqual(calls, ['a']);
    assert.deepEqual(result.ran, ['hook-a']);
    assert.equal(result.aborted, false);
    assert.equal(result.skipped, false);
    assert.equal(result.errors.length, 0);
  });

  it('should not run hooks for non-matching event', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'hook-a',
      event: 'provider:after',
      handler: async () => { calls.push('a'); },
    });

    const ctx = makeProviderBeforeCtx();
    const result = await pipeline.run(ctx);

    assert.deepEqual(calls, []);
    assert.deepEqual(result.ran, []);
  });

  it('should run multiple hooks for the same event', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'hook-a',
      event: 'provider:before',
      handler: async () => { calls.push('a'); },
    });
    pipeline.register({
      id: 'hook-b',
      event: 'provider:before',
      handler: async () => { calls.push('b'); },
    });

    const result = await pipeline.run(makeProviderBeforeCtx());
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(result.ran, ['hook-a', 'hook-b']);
  });

  // -----------------------------------------------------------------------
  // Priority ordering
  // -----------------------------------------------------------------------

  it('should run hooks in priority order (lower first)', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'hook-c',
      event: 'provider:before',
      priority: 90,
      handler: async () => { calls.push('c'); },
    });
    pipeline.register({
      id: 'hook-a',
      event: 'provider:before',
      priority: 10,
      handler: async () => { calls.push('a'); },
    });
    pipeline.register({
      id: 'hook-b',
      event: 'provider:before',
      priority: 50,
      handler: async () => { calls.push('b'); },
    });

    await pipeline.run(makeProviderBeforeCtx());
    assert.deepEqual(calls, ['a', 'b', 'c']);
  });

  it('should use default priority 50 when not specified', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'explicit-50',
      event: 'provider:before',
      priority: 50,
      handler: async () => { calls.push('explicit'); },
    });
    pipeline.register({
      id: 'default-50',
      event: 'provider:before',
      // No priority — should default to 50
      handler: async () => { calls.push('default'); },
    });
    pipeline.register({
      id: 'low-priority',
      event: 'provider:before',
      priority: 10,
      handler: async () => { calls.push('low'); },
    });

    await pipeline.run(makeProviderBeforeCtx());
    // low (10), then explicit and default (both 50, insertion order)
    assert.equal(calls[0], 'low');
    assert.ok(calls.includes('explicit'));
    assert.ok(calls.includes('default'));
  });

  // -----------------------------------------------------------------------
  // Data passing (context mutation)
  // -----------------------------------------------------------------------

  it('should pass mutated context through the pipeline', async () => {
    const pipeline = new HookPipelineImpl();

    pipeline.register({
      id: 'set-flag',
      event: 'provider:before',
      priority: 10,
      handler: async (ctx) => {
        ctx.metadata.rateLimited = true;
      },
    });
    pipeline.register({
      id: 'read-flag',
      event: 'provider:before',
      priority: 20,
      handler: async (ctx) => {
        if (ctx.metadata.rateLimited) {
          (ctx as ProviderBeforeContext).skip = true;
        }
      },
    });

    const ctx = makeProviderBeforeCtx();
    const result = await pipeline.run(ctx);

    assert.equal(result.context.metadata.rateLimited, true);
    assert.equal((result.context as ProviderBeforeContext).skip, true);
  });

  it('should allow hooks to modify messages array', async () => {
    const pipeline = new HookPipelineImpl();

    pipeline.register({
      id: 'inject-system-msg',
      event: 'provider:before',
      handler: async (ctx) => {
        (ctx as ProviderBeforeContext).messages.push({ role: 'system', content: 'injected' });
      },
    });

    const ctx = makeProviderBeforeCtx({ messages: [{ role: 'user', content: 'hi' }] });
    await pipeline.run(ctx);

    assert.equal(ctx.messages.length, 2);
    assert.deepEqual(ctx.messages[1], { role: 'system', content: 'injected' });
  });

  // -----------------------------------------------------------------------
  // Short-circuit: abort
  // -----------------------------------------------------------------------

  it('should abort pipeline when hook returns "abort"', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'blocker',
      event: 'tool:before',
      priority: 10,
      handler: async (ctx) => {
        (ctx as ToolBeforeContext).blocked = true;
        (ctx as ToolBeforeContext).blockReason = 'Dangerous command';
        calls.push('blocker');
        return 'abort';
      },
    });
    pipeline.register({
      id: 'logger',
      event: 'tool:before',
      priority: 20,
      handler: async () => {
        calls.push('logger');
      },
    });

    const ctx = makeToolBeforeCtx({ args: { command: 'rm -rf /' } });
    const result = await pipeline.run(ctx);

    assert.deepEqual(calls, ['blocker']);
    assert.equal(result.aborted, true);
    assert.equal(result.skipped, false);
    assert.equal((result.context as ToolBeforeContext).blocked, true);
    // Logger never ran
    assert.ok(!result.ran.includes('logger'));
  });

  // -----------------------------------------------------------------------
  // Short-circuit: skip
  // -----------------------------------------------------------------------

  it('should skip remaining hooks when hook returns "skip"', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'skipper',
      event: 'provider:before',
      priority: 10,
      handler: async () => {
        calls.push('skipper');
        return 'skip';
      },
    });
    pipeline.register({
      id: 'after-skip',
      event: 'provider:before',
      priority: 20,
      handler: async () => {
        calls.push('after-skip');
      },
    });

    const result = await pipeline.run(makeProviderBeforeCtx());

    assert.deepEqual(calls, ['skipper']);
    assert.equal(result.aborted, false);
    assert.equal(result.skipped, true);
  });

  // -----------------------------------------------------------------------
  // Error modes
  // -----------------------------------------------------------------------

  it('should continue past errors with onError: "continue" (default)', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'throws',
      event: 'provider:before',
      priority: 10,
      // onError defaults to 'continue'
      handler: async () => {
        throw new Error('boom');
      },
    });
    pipeline.register({
      id: 'survives',
      event: 'provider:before',
      priority: 20,
      handler: async () => {
        calls.push('survives');
      },
    });

    const result = await pipeline.run(makeProviderBeforeCtx());

    assert.deepEqual(calls, ['survives']);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].hookId, 'throws');
    assert.equal(result.errors[0].error.message, 'boom');
    assert.equal(result.aborted, false);
  });

  it('should abort pipeline with onError: "abort"', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'critical',
      event: 'provider:before',
      priority: 10,
      onError: 'abort',
      handler: async () => {
        throw new Error('critical failure');
      },
    });
    pipeline.register({
      id: 'never-runs',
      event: 'provider:before',
      priority: 20,
      handler: async () => {
        calls.push('never-runs');
      },
    });

    const result = await pipeline.run(makeProviderBeforeCtx());

    assert.deepEqual(calls, []);
    assert.equal(result.aborted, true);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].error.message, 'critical failure');
  });

  it('should retry once with onError: "retry" and succeed', async () => {
    const pipeline = new HookPipelineImpl();
    let attempts = 0;

    pipeline.register({
      id: 'flaky',
      event: 'provider:before',
      onError: 'retry',
      handler: async () => {
        attempts++;
        if (attempts === 1) throw new Error('transient');
        // Second attempt succeeds
      },
    });

    const result = await pipeline.run(makeProviderBeforeCtx());

    assert.equal(attempts, 2);
    assert.equal(result.errors.length, 0);
    assert.equal(result.aborted, false);
    assert.ok(result.ran.includes('flaky'));
  });

  it('should continue after retry failure with onError: "retry"', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'always-fails',
      event: 'provider:before',
      priority: 10,
      onError: 'retry',
      handler: async () => {
        throw new Error('permanent');
      },
    });
    pipeline.register({
      id: 'after-retry',
      event: 'provider:before',
      priority: 20,
      handler: async () => {
        calls.push('after-retry');
      },
    });

    const result = await pipeline.run(makeProviderBeforeCtx());

    assert.deepEqual(calls, ['after-retry']);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].error.message, 'permanent');
    assert.equal(result.aborted, false);
  });

  // -----------------------------------------------------------------------
  // Filters
  // -----------------------------------------------------------------------

  it('should filter by agentId', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'opus-only',
      event: 'provider:before',
      agentFilter: ['opus'],
      handler: async () => { calls.push('opus-only'); },
    });
    pipeline.register({
      id: 'all-agents',
      event: 'provider:before',
      handler: async () => { calls.push('all-agents'); },
    });

    // Run with opus — both fire
    await pipeline.run(makeProviderBeforeCtx({ agentId: 'opus' }));
    assert.deepEqual(calls, ['opus-only', 'all-agents']);

    calls.length = 0;

    // Run with grok — only all-agents fires
    await pipeline.run(makeProviderBeforeCtx({ agentId: 'grok' }));
    assert.deepEqual(calls, ['all-agents']);
  });

  it('should filter by toolName', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'shell-guard',
      event: 'tool:before',
      toolFilter: ['shell'],
      handler: async () => { calls.push('shell-guard'); },
    });

    // Shell tool — fires
    await pipeline.run(makeToolBeforeCtx({ toolName: 'shell' }));
    assert.deepEqual(calls, ['shell-guard']);

    calls.length = 0;

    // File_read tool — doesn't fire
    await pipeline.run(makeToolBeforeCtx({ toolName: 'file_read' }));
    assert.deepEqual(calls, []);
  });

  // -----------------------------------------------------------------------
  // Enabled/disabled
  // -----------------------------------------------------------------------

  it('should skip disabled hooks', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'disabled',
      event: 'provider:before',
      enabled: false,
      handler: async () => { calls.push('disabled'); },
    });
    pipeline.register({
      id: 'enabled',
      event: 'provider:before',
      handler: async () => { calls.push('enabled'); },
    });

    await pipeline.run(makeProviderBeforeCtx());
    assert.deepEqual(calls, ['enabled']);
  });

  // -----------------------------------------------------------------------
  // Registration management
  // -----------------------------------------------------------------------

  it('should unregister hooks by ID', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'removable',
      event: 'provider:before',
      handler: async () => { calls.push('removable'); },
    });

    assert.equal(pipeline.unregister('removable'), true);
    assert.equal(pipeline.unregister('nonexistent'), false);

    await pipeline.run(makeProviderBeforeCtx());
    assert.deepEqual(calls, []);
  });

  it('should replace hooks with duplicate IDs', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'dupe',
      event: 'provider:before',
      handler: async () => { calls.push('first'); },
    });
    pipeline.register({
      id: 'dupe',
      event: 'provider:before',
      handler: async () => { calls.push('second'); },
    });

    await pipeline.run(makeProviderBeforeCtx());
    assert.deepEqual(calls, ['second']);
  });

  it('should clear all hooks', async () => {
    const pipeline = new HookPipelineImpl();

    pipeline.register({
      id: 'a',
      event: 'provider:before',
      handler: async () => {},
    });
    pipeline.register({
      id: 'b',
      event: 'tool:before',
      handler: async () => {},
    });

    pipeline.clear();
    assert.deepEqual(pipeline.getHooks(), []);
  });

  it('should list hooks filtered by event', () => {
    const pipeline = new HookPipelineImpl();

    pipeline.register({
      id: 'provider-hook',
      event: 'provider:before',
      handler: async () => {},
    });
    pipeline.register({
      id: 'tool-hook',
      event: 'tool:before',
      handler: async () => {},
    });

    const providerHooks = pipeline.getHooks('provider:before');
    assert.equal(providerHooks.length, 1);
    assert.equal(providerHooks[0].id, 'provider-hook');

    const allHooks = pipeline.getHooks();
    assert.equal(allHooks.length, 2);
  });

  // -----------------------------------------------------------------------
  // Async behavior
  // -----------------------------------------------------------------------

  it('should handle async hooks correctly', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'slow',
      event: 'provider:before',
      priority: 10,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 10));
        calls.push('slow');
      },
    });
    pipeline.register({
      id: 'fast',
      event: 'provider:before',
      priority: 20,
      handler: async () => {
        calls.push('fast');
      },
    });

    await pipeline.run(makeProviderBeforeCtx());
    // Slow completes before fast starts (sequential, not parallel)
    assert.deepEqual(calls, ['slow', 'fast']);
  });

  it('should handle synchronous hooks (no async)', async () => {
    const pipeline = new HookPipelineImpl();
    const calls: string[] = [];

    pipeline.register({
      id: 'sync',
      event: 'provider:before',
      handler: () => { calls.push('sync'); },
    });

    await pipeline.run(makeProviderBeforeCtx());
    assert.deepEqual(calls, ['sync']);
  });

  // -----------------------------------------------------------------------
  // Empty pipeline
  // -----------------------------------------------------------------------

  it('should handle empty pipeline gracefully', async () => {
    const pipeline = new HookPipelineImpl();
    const ctx = makeProviderBeforeCtx();
    const result = await pipeline.run(ctx);

    assert.equal(result.aborted, false);
    assert.equal(result.skipped, false);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.ran, []);
    assert.equal(result.context, ctx); // Same reference
  });

  // -----------------------------------------------------------------------
  // Provider:error with fallback context
  // -----------------------------------------------------------------------

  it('should allow provider:error hooks to set retry info', async () => {
    const pipeline = new HookPipelineImpl();

    pipeline.register({
      id: 'fallback',
      event: 'provider:error',
      handler: async (ctx) => {
        const errCtx = ctx as ProviderErrorContext;
        if (errCtx.statusCode === 429) {
          errCtx.retry = {
            providerId: 'google',
            model: 'gemini-2.0-flash',
          };
        }
      },
    });

    const ctx: ProviderErrorContext = {
      event: 'provider:error',
      providerId: 'google',
      model: 'gemini-2.5-pro',
      error: new Error('RESOURCE_EXHAUSTED'),
      statusCode: 429,
      timestamp: Date.now(),
      metadata: {},
    };

    const result = await pipeline.run(ctx);
    assert.equal(result.context.retry?.providerId, 'google');
    assert.equal(result.context.retry?.model, 'gemini-2.0-flash');
  });

  // -----------------------------------------------------------------------
  // Realistic scenario: safety + logging pipeline
  // -----------------------------------------------------------------------

  it('should compose a realistic safety + logging pipeline', async () => {
    const pipeline = new HookPipelineImpl();
    const auditLog: string[] = [];

    // Safety hook — blocks dangerous commands
    pipeline.register({
      id: 'safety-gate',
      event: 'tool:before',
      priority: 10,
      toolFilter: ['shell'],
      handler: async (ctx) => {
        const toolCtx = ctx as ToolBeforeContext;
        const cmd = toolCtx.args.command as string;
        if (cmd.includes('rm -rf')) {
          toolCtx.blocked = true;
          toolCtx.blockReason = 'Destructive command blocked by safety hook';
          return 'abort';
        }
      },
    });

    // Audit hook — logs all tool calls
    pipeline.register({
      id: 'audit-log',
      event: 'tool:before',
      priority: 90,
      handler: async (ctx) => {
        const toolCtx = ctx as ToolBeforeContext;
        auditLog.push(`${toolCtx.toolName}: ${JSON.stringify(toolCtx.args)}`);
      },
    });

    // Safe command — both hooks run
    const safeCtx = makeToolBeforeCtx({ args: { command: 'ls -la' } });
    const safeResult = await pipeline.run(safeCtx);
    assert.equal(safeResult.aborted, false);
    assert.equal(auditLog.length, 1);

    // Dangerous command — safety aborts before audit
    const dangerCtx = makeToolBeforeCtx({ args: { command: 'rm -rf /' } });
    const dangerResult = await pipeline.run(dangerCtx);
    assert.equal(dangerResult.aborted, true);
    assert.equal((dangerResult.context as ToolBeforeContext).blocked, true);
    assert.equal(auditLog.length, 1); // Audit never ran for the dangerous one
  });
});
