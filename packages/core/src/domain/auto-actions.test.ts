/**
 * Tests for auto-action hooks — M2.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookPipelineImpl } from './hooks.js';
import {
  createAutoFormatHook,
  createAutoLintHook,
  createAutoTestHook,
  createAutoGitCheckHook,
  createCustomActionHook,
  createAutoActionHooks,
} from './auto-actions.js';
import type { ToolAfterContext } from '@rivetos/types';
import type { ShellExecutor } from './auto-actions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolAfterCtx(toolName: string, args: Record<string, unknown>, isError = false): ToolAfterContext {
  return {
    event: 'tool:after',
    toolName,
    args,
    result: 'ok',
    durationMs: 10,
    isError,
    timestamp: Date.now(),
    metadata: {},
  };
}

function makeShell(exitCode = 0, stdout = '', stderr = ''): ShellExecutor {
  return {
    exec: vi.fn().mockResolvedValue({ stdout, stderr, exitCode }),
  };
}

// ---------------------------------------------------------------------------
// Auto-Format
// ---------------------------------------------------------------------------

describe('Auto-Format Hook', () => {
  it('runs prettier on .ts files after file_write', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoFormatHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/opt/rivetos/src/index.ts' });
    await pipeline.run(ctx);

    expect(shell.exec).toHaveBeenCalledOnce();
    expect((shell.exec as any).mock.calls[0][0]).toContain('prettier');
    expect(ctx.metadata.autoFormat).toEqual({ file: '/opt/rivetos/src/index.ts', status: 'formatted' });
  });

  it('skips non-formattable files', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoFormatHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/opt/rivetos/image.png' });
    await pipeline.run(ctx);

    expect(shell.exec).not.toHaveBeenCalled();
  });

  it('skips on tool error', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoFormatHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/src/test.ts' }, true);
    await pipeline.run(ctx);

    expect(shell.exec).not.toHaveBeenCalled();
  });

  it('soft-fails if prettier is not available', async () => {
    const shell: ShellExecutor = {
      exec: vi.fn().mockRejectedValue(new Error('command not found')),
    };
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoFormatHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/src/test.ts' });
    await pipeline.run(ctx);

    expect(ctx.metadata.autoFormat).toEqual({
      file: '/src/test.ts',
      status: 'skipped',
      reason: 'prettier not available',
    });
  });

  it('formats JSON files', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoFormatHook({ shell }));

    const ctx = makeToolAfterCtx('file_edit', { path: '/config.json' });
    await pipeline.run(ctx);

    expect(shell.exec).toHaveBeenCalledOnce();
  });

  it('only fires for file_write and file_edit', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoFormatHook({ shell }));

    const ctx = makeToolAfterCtx('shell', { path: '/src/test.ts' });
    await pipeline.run(ctx);

    expect(shell.exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auto-Lint
// ---------------------------------------------------------------------------

describe('Auto-Lint Hook', () => {
  it('runs eslint on .ts files', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoLintHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/src/index.ts' });
    await pipeline.run(ctx);

    expect(shell.exec).toHaveBeenCalledOnce();
    expect((shell.exec as any).mock.calls[0][0]).toContain('eslint');
    expect(ctx.metadata.autoLint).toEqual({ file: '/src/index.ts', status: 'linted' });
  });

  it('reports lint issues', async () => {
    const shell = makeShell(1, '', 'Missing semicolon');
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoLintHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/src/index.ts' });
    await pipeline.run(ctx);

    expect(ctx.metadata.autoLint).toMatchObject({
      file: '/src/index.ts',
      status: 'issues',
    });
  });

  it('skips CSS files', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoLintHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/src/style.css' });
    await pipeline.run(ctx);

    expect(shell.exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auto-Test
// ---------------------------------------------------------------------------

describe('Auto-Test Hook', () => {
  it('runs vitest related on src changes', async () => {
    const shell = makeShell(0, 'Tests: 3 passed');
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoTestHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/opt/rivetos/packages/core/src/domain/hooks.ts' });
    await pipeline.run(ctx);

    expect(shell.exec).toHaveBeenCalledOnce();
    expect((shell.exec as any).mock.calls[0][0]).toContain('vitest');
    expect(ctx.metadata.autoTest).toMatchObject({ status: 'passed' });
  });

  it('reports test failures', async () => {
    const shell = makeShell(1, 'FAIL: expected true to be false');
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoTestHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/opt/rivetos/packages/core/src/test.ts' });
    await pipeline.run(ctx);

    expect(ctx.metadata.autoTest).toMatchObject({ status: 'failed' });
  });

  it('skips test files themselves', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoTestHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/packages/core/src/domain/hooks.test.ts' });
    await pipeline.run(ctx);

    expect(shell.exec).not.toHaveBeenCalled();
  });

  it('skips non-source files', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoTestHook({ shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/README.md' });
    await pipeline.run(ctx);

    expect(shell.exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auto Git Check
// ---------------------------------------------------------------------------

describe('Auto Git Check Hook', () => {
  it('runs tsc after git commit', async () => {
    const shell = makeShell(0, 'No errors');
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoGitCheckHook({ shell }));

    const ctx = makeToolAfterCtx('shell', { command: 'git commit -m "test"' });
    await pipeline.run(ctx);

    expect(shell.exec).toHaveBeenCalledOnce();
    expect(ctx.metadata.autoGitCheck).toMatchObject({ status: 'passed' });
  });

  it('reports type errors', async () => {
    const shell = makeShell(1, 'error TS2345');
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoGitCheckHook({ shell }));

    const ctx = makeToolAfterCtx('shell', { command: 'git commit -m "broken"' });
    await pipeline.run(ctx);

    expect(ctx.metadata.autoGitCheck).toMatchObject({ status: 'issues' });
  });

  it('ignores non-commit shell commands', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createAutoGitCheckHook({ shell }));

    const ctx = makeToolAfterCtx('shell', { command: 'git push origin main' });
    await pipeline.run(ctx);

    expect(shell.exec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Custom Action
// ---------------------------------------------------------------------------

describe('Custom Action Hook', () => {
  it('runs custom command with file interpolation', async () => {
    const shell = makeShell(0, 'ok');
    const pipeline = new HookPipelineImpl();
    pipeline.register(createCustomActionHook({
      id: 'my-action',
      description: 'test action',
      command: 'echo {{file}}',
    }, { shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/test.ts' });
    await pipeline.run(ctx);

    expect((shell.exec as any).mock.calls[0][0]).toBe('echo /test.ts');
    expect(ctx.metadata['auto:my-action']).toMatchObject({ status: 'success' });
  });

  it('respects file pattern filter', async () => {
    const shell = makeShell(0);
    const pipeline = new HookPipelineImpl();
    pipeline.register(createCustomActionHook({
      id: 'ts-only',
      description: 'ts only',
      filePattern: /\.ts$/,
      command: 'echo {{file}}',
    }, { shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/test.md' });
    await pipeline.run(ctx);

    expect(shell.exec).not.toHaveBeenCalled();
  });

  it('soft-fails when configured', async () => {
    const shell: ShellExecutor = {
      exec: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const pipeline = new HookPipelineImpl();
    pipeline.register(createCustomActionHook({
      id: 'soft',
      description: 'soft fail',
      command: 'exit 1',
      softFail: true,
    }, { shell }));

    const ctx = makeToolAfterCtx('file_write', { path: '/test.ts' });
    const result = await pipeline.run(ctx);

    // Should not abort
    expect(result.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aggregate: createAutoActionHooks
// ---------------------------------------------------------------------------

describe('createAutoActionHooks', () => {
  const shell = makeShell(0);

  it('returns empty array when nothing enabled', () => {
    const hooks = createAutoActionHooks({ shell });
    expect(hooks).toHaveLength(0);
  });

  it('returns all hooks when everything enabled', () => {
    const hooks = createAutoActionHooks({
      shell,
      autoFormat: true,
      autoLint: true,
      autoTest: true,
      autoGitCheck: true,
    });
    expect(hooks).toHaveLength(4);
  });

  it('includes custom actions', () => {
    const hooks = createAutoActionHooks({
      shell,
      customActions: [
        { id: 'a', description: 'a', command: 'echo a' },
        { id: 'b', description: 'b', command: 'echo b' },
      ],
    });
    expect(hooks).toHaveLength(2);
  });
});
