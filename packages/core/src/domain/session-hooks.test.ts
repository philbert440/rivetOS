/**
 * Tests for session hooks — M2.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookPipelineImpl } from './hooks.js';
import {
  createSessionStartHook,
  createSessionSummaryHook,
  createAutoCommitHook,
  createPreCompactHook,
  createPostCompactHook,
  createSessionHooks,
} from './session-hooks.js';
import type {
  SessionStartContext,
  SessionEndContext,
  CompactBeforeContext,
  CompactAfterContext,
} from '@rivetos/types';
import type { SessionHooksContext } from './session-hooks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionStartCtx(overrides?: Partial<SessionStartContext>): SessionStartContext {
  return {
    event: 'session:start',
    timestamp: Date.now(),
    metadata: {},
    platform: 'telegram',
    userId: 'user-1',
    ...overrides,
  };
}

function makeSessionEndCtx(overrides?: Partial<SessionEndContext>): SessionEndContext {
  return {
    event: 'session:end',
    timestamp: Date.now(),
    metadata: {},
    turnCount: 5,
    totalTokens: { prompt: 1000, completion: 500 },
    agentId: 'opus',
    ...overrides,
  };
}

function makeCompactBeforeCtx(overrides?: Partial<CompactBeforeContext>): CompactBeforeContext {
  return {
    event: 'compact:before',
    timestamp: Date.now(),
    metadata: {},
    messageCount: 100,
    ...overrides,
  };
}

function makeCompactAfterCtx(overrides?: Partial<CompactAfterContext>): CompactAfterContext {
  return {
    event: 'compact:after',
    timestamp: Date.now(),
    metadata: {},
    remainingMessages: 10,
    summary: 'Session discussed hooks and testing.',
    ...overrides,
  };
}

function makeContext(overrides?: Partial<SessionHooksContext>): SessionHooksContext {
  return {
    workspaceDir: '/home/philbot/workspace',
    fileWriter: {
      write: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue(null),
      append: vi.fn().mockResolvedValue(undefined),
    },
    shell: {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Session Start
// ---------------------------------------------------------------------------

describe('Session Start Hook', () => {
  it('records session metadata', async () => {
    const ctx = makeContext();
    const pipeline = new HookPipelineImpl();
    pipeline.register(createSessionStartHook(ctx));

    const hookCtx = makeSessionStartCtx();
    await pipeline.run(hookCtx);

    expect(hookCtx.metadata.sessionStartTime).toBeDefined();
    expect(hookCtx.metadata.platform).toBe('telegram');
    expect(hookCtx.metadata.userId).toBe('user-1');
  });

  it('loads daily context when available', async () => {
    const ctx = makeContext();
    (ctx.fileWriter!.read as any).mockResolvedValue('# Today\n- Worked on hooks');

    const pipeline = new HookPipelineImpl();
    pipeline.register(createSessionStartHook(ctx));

    const hookCtx = makeSessionStartCtx();
    await pipeline.run(hookCtx);

    expect(hookCtx.metadata.dailyContext).toContain('Worked on hooks');
  });

  it('handles missing daily note gracefully', async () => {
    const ctx = makeContext();
    (ctx.fileWriter!.read as any).mockResolvedValue(null);

    const pipeline = new HookPipelineImpl();
    pipeline.register(createSessionStartHook(ctx));

    const hookCtx = makeSessionStartCtx();
    await pipeline.run(hookCtx);

    expect(hookCtx.metadata.dailyContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session End Summary
// ---------------------------------------------------------------------------

describe('Session Summary Hook', () => {
  it('writes session summary to daily notes', async () => {
    const ctx = makeContext();
    const pipeline = new HookPipelineImpl();
    pipeline.register(createSessionSummaryHook(ctx));

    const hookCtx = makeSessionEndCtx();
    await pipeline.run(hookCtx);

    expect(ctx.fileWriter!.append).toHaveBeenCalledOnce();
    const appendedContent = (ctx.fileWriter!.append as any).mock.calls[0][1];
    expect(appendedContent).toContain('Session ended');
    expect(appendedContent).toContain('Agent: opus');
    expect(appendedContent).toContain('Turns: 5');
    expect(appendedContent).toContain('Tokens:');
    expect(hookCtx.metadata.summaryWritten).toBe(true);
  });

  it('handles write failure gracefully', async () => {
    const ctx = makeContext();
    (ctx.fileWriter!.append as any).mockRejectedValue(new Error('disk full'));

    const pipeline = new HookPipelineImpl();
    pipeline.register(createSessionSummaryHook(ctx));

    const hookCtx = makeSessionEndCtx();
    await pipeline.run(hookCtx);

    expect(hookCtx.metadata.summaryWritten).toBe(false);
  });

  it('skips if no file writer', async () => {
    const ctx: SessionHooksContext = { workspaceDir: '/test' };
    const pipeline = new HookPipelineImpl();
    pipeline.register(createSessionSummaryHook(ctx));

    const hookCtx = makeSessionEndCtx();
    await pipeline.run(hookCtx);

    // No crash, no metadata set
    expect(hookCtx.metadata.summaryWritten).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auto Commit
// ---------------------------------------------------------------------------

describe('Auto Commit Hook', () => {
  it('commits when there are changes', async () => {
    const ctx = makeContext();
    (ctx.shell!.exec as any)
      .mockResolvedValueOnce({ stdout: ' M file.ts\n', stderr: '', exitCode: 0 }) // git status
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add
      .mockResolvedValueOnce({ stdout: '[main abc123] auto commit', stderr: '', exitCode: 0 }); // git commit

    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoCommitHook(ctx));

    const hookCtx = makeSessionEndCtx();
    await pipeline.run(hookCtx);

    expect(ctx.shell!.exec).toHaveBeenCalledTimes(3);
    expect(hookCtx.metadata.autoCommit).toMatchObject({ status: 'committed' });
  });

  it('reports clean when no changes', async () => {
    const ctx = makeContext();
    (ctx.shell!.exec as any).mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoCommitHook(ctx));

    const hookCtx = makeSessionEndCtx();
    await pipeline.run(hookCtx);

    expect(hookCtx.metadata.autoCommit).toMatchObject({ status: 'clean' });
  });

  it('handles commit failure', async () => {
    const ctx = makeContext();
    (ctx.shell!.exec as any)
      .mockResolvedValueOnce({ stdout: ' M file.ts\n', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'error', exitCode: 1 });

    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoCommitHook(ctx));

    const hookCtx = makeSessionEndCtx();
    await pipeline.run(hookCtx);

    expect(hookCtx.metadata.autoCommit).toMatchObject({ status: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// Compaction Hooks
// ---------------------------------------------------------------------------

describe('Pre-Compact Hook', () => {
  it('captures pre-compaction snapshot', async () => {
    const pipeline = new HookPipelineImpl();
    pipeline.register(createPreCompactHook());

    const ctx = makeCompactBeforeCtx({ messageCount: 150 });
    await pipeline.run(ctx);

    expect(ctx.metadata.preCompactSnapshot).toBeDefined();
    expect((ctx.metadata.preCompactSnapshot as any).messageCount).toBe(150);
  });
});

describe('Post-Compact Hook', () => {
  it('calculates compression ratio', async () => {
    const sessionCtx = makeContext();
    const pipeline = new HookPipelineImpl();
    pipeline.register(createPostCompactHook(sessionCtx));

    const ctx = makeCompactAfterCtx({ remainingMessages: 10 });
    ctx.metadata.preCompactSnapshot = { messageCount: 100, timestamp: Date.now() };
    await pipeline.run(ctx);

    expect(ctx.metadata.compactionResult).toBeDefined();
    expect((ctx.metadata.compactionResult as any).compressionRatio).toBe('90.0%');
    expect((ctx.metadata.compactionResult as any).summaryGenerated).toBe(true);
  });

  it('logs compaction to daily notes', async () => {
    const sessionCtx = makeContext();
    const pipeline = new HookPipelineImpl();
    pipeline.register(createPostCompactHook(sessionCtx));

    const ctx = makeCompactAfterCtx();
    ctx.metadata.preCompactSnapshot = { messageCount: 100, timestamp: Date.now() };
    await pipeline.run(ctx);

    expect(sessionCtx.fileWriter!.append).toHaveBeenCalledOnce();
    const logged = (sessionCtx.fileWriter!.append as any).mock.calls[0][1];
    expect(logged).toContain('Compaction');
    expect(logged).toContain('100');
    expect(logged).toContain('10');
  });

  it('handles missing pre-compact snapshot', async () => {
    const sessionCtx = makeContext();
    const pipeline = new HookPipelineImpl();
    pipeline.register(createPostCompactHook(sessionCtx));

    const ctx = makeCompactAfterCtx();
    // No preCompactSnapshot in metadata
    await pipeline.run(ctx);

    expect(ctx.metadata.compactionResult).toBeDefined();
    expect((ctx.metadata.compactionResult as any).originalMessages).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Aggregate: createSessionHooks
// ---------------------------------------------------------------------------

describe('createSessionHooks', () => {
  it('creates all hooks by default', () => {
    const hooks = createSessionHooks({ context: makeContext() });
    // session:start (1) + session:end summary (1) + compact:before (1) + compact:after (1) = 4
    // autoCommit is OFF by default
    expect(hooks).toHaveLength(4);
  });

  it('includes auto-commit when enabled', () => {
    const hooks = createSessionHooks({ context: makeContext(), autoCommit: true });
    expect(hooks).toHaveLength(5);
  });

  it('can disable individual hooks', () => {
    const hooks = createSessionHooks({
      context: makeContext(),
      sessionStart: false,
      sessionSummary: false,
      preCompact: false,
      postCompact: false,
    });
    expect(hooks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Full pipeline integration
// ---------------------------------------------------------------------------

describe('Session hooks pipeline integration', () => {
  it('pre-compact → post-compact data passing works', async () => {
    const sessionCtx = makeContext();
    const pipeline = new HookPipelineImpl();
    pipeline.register(createPreCompactHook());
    pipeline.register(createPostCompactHook(sessionCtx));

    // Simulate compact:before
    const beforeCtx = makeCompactBeforeCtx({ messageCount: 200 });
    await pipeline.run(beforeCtx);

    // Simulate compact:after — carry over metadata
    const afterCtx = makeCompactAfterCtx({ remainingMessages: 15 });
    afterCtx.metadata = { ...beforeCtx.metadata }; // Carry metadata across
    await pipeline.run(afterCtx);

    expect((afterCtx.metadata.compactionResult as any).originalMessages).toBe(200);
    expect((afterCtx.metadata.compactionResult as any).remainingMessages).toBe(15);
    expect((afterCtx.metadata.compactionResult as any).compressionRatio).toBe('92.5%');
  });
});
