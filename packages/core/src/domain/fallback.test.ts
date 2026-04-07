/**
 * Fallback hook tests — trigger codes, timeout detection, chain progression,
 * cooldown reset, cross-provider fallback, auth failure, chain exhaustion.
 */

import { describe, it, beforeEach } from 'vitest';
import * as assert from 'node:assert/strict';
import { HookPipelineImpl } from './hooks.js';
import { createFallbackHookWithState } from './fallback.js';
import type { ProviderErrorContext, FallbackConfig } from '@rivetos/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeErrorCtx(overrides: Partial<ProviderErrorContext> = {}): ProviderErrorContext {
  return {
    event: 'provider:error',
    providerId: 'google',
    model: 'gemini-2.5-pro',
    error: new Error('RESOURCE_EXHAUSTED'),
    statusCode: 429,
    timestamp: Date.now(),
    metadata: {},
    ...overrides,
  };
}

const defaultConfigs: FallbackConfig[] = [
  {
    providerId: 'google',
    fallbacks: ['gemini-2.0-flash', 'gemini-2.0-flash-lite'],
    triggerCodes: [429, 503],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Fallback Hook', () => {
  let pipeline: HookPipelineImpl;
  let resetState: () => void;

  beforeEach(() => {
    pipeline = new HookPipelineImpl();
    const { hook, reset } = createFallbackHookWithState(defaultConfigs);
    pipeline.register(hook);
    resetState = reset;
  });

  // -----------------------------------------------------------------------
  // Basic fallback
  // -----------------------------------------------------------------------

  it('should set retry on 429 error', async () => {
    const ctx = makeErrorCtx({ statusCode: 429 });
    await pipeline.run(ctx);

    assert.ok(ctx.retry);
    assert.equal(ctx.retry.providerId, 'google');
    assert.equal(ctx.retry.model, 'gemini-2.0-flash');
    assert.equal(ctx.metadata.fallbackReason, 'HTTP 429');
  });

  it('should set retry on 503 error', async () => {
    const ctx = makeErrorCtx({ statusCode: 503 });
    await pipeline.run(ctx);

    assert.ok(ctx.retry);
    assert.equal(ctx.retry.model, 'gemini-2.0-flash');
  });

  it('should not trigger on non-configured status codes', async () => {
    const ctx = makeErrorCtx({ statusCode: 400 });
    await pipeline.run(ctx);

    assert.equal(ctx.retry, undefined);
  });

  // -----------------------------------------------------------------------
  // Chain progression
  // -----------------------------------------------------------------------

  it('should progress through fallback chain', async () => {
    // First error → first fallback
    const ctx1 = makeErrorCtx({ statusCode: 429, sessionId: 'sess1' });
    await pipeline.run(ctx1);
    assert.equal(ctx1.retry?.model, 'gemini-2.0-flash');

    // Second error → second fallback
    const ctx2 = makeErrorCtx({ statusCode: 429, sessionId: 'sess1' });
    await pipeline.run(ctx2);
    assert.equal(ctx2.retry?.model, 'gemini-2.0-flash-lite');
  });

  it('should exhaust chain and stop retrying', async () => {
    // First two errors use the chain
    const ctx1 = makeErrorCtx({ statusCode: 429, sessionId: 'sess2' });
    await pipeline.run(ctx1);
    assert.ok(ctx1.retry);

    const ctx2 = makeErrorCtx({ statusCode: 429, sessionId: 'sess2' });
    await pipeline.run(ctx2);
    assert.ok(ctx2.retry);

    // Third error — chain exhausted
    const ctx3 = makeErrorCtx({ statusCode: 429, sessionId: 'sess2' });
    await pipeline.run(ctx3);
    assert.equal(ctx3.retry, undefined);
  });

  // -----------------------------------------------------------------------
  // Timeout detection
  // -----------------------------------------------------------------------

  it('should trigger on timeout errors', async () => {
    const ctx = makeErrorCtx({
      statusCode: undefined,
      error: new Error('Request timeout: ETIMEDOUT'),
    });
    await pipeline.run(ctx);

    assert.ok(ctx.retry);
    assert.equal(ctx.metadata.fallbackReason, 'timeout');
  });

  it('should trigger on socket hang up', async () => {
    const ctx = makeErrorCtx({
      statusCode: undefined,
      error: new Error('socket hang up'),
    });
    await pipeline.run(ctx);

    assert.ok(ctx.retry);
  });

  it('should trigger on AbortError', async () => {
    const ctx = makeErrorCtx({
      statusCode: undefined,
      error: new Error('AbortError: The operation was aborted'),
    });
    await pipeline.run(ctx);

    assert.ok(ctx.retry);
  });

  // -----------------------------------------------------------------------
  // Auth failure
  // -----------------------------------------------------------------------

  it('should NOT trigger on auth failure by default', async () => {
    const ctx = makeErrorCtx({ statusCode: 401 });
    await pipeline.run(ctx);

    assert.equal(ctx.retry, undefined);
  });

  it('should trigger on auth failure when configured', async () => {
    const pipeline2 = new HookPipelineImpl();
    const { hook } = createFallbackHookWithState([
      {
        providerId: 'google',
        fallbacks: ['gemini-2.0-flash'],
        triggerOnAuthFailure: true,
      },
    ]);
    pipeline2.register(hook);

    const ctx = makeErrorCtx({ statusCode: 401 });
    await pipeline2.run(ctx);

    assert.ok(ctx.retry);
  });

  // -----------------------------------------------------------------------
  // Cross-provider fallback
  // -----------------------------------------------------------------------

  it('should support cross-provider fallback (provider:model syntax)', async () => {
    const pipeline2 = new HookPipelineImpl();
    const { hook } = createFallbackHookWithState([
      {
        providerId: 'google',
        fallbacks: ['google:gemini-2.0-flash', 'anthropic:claude-sonnet-4-20250514'],
      },
    ]);
    pipeline2.register(hook);

    // First fallback — same provider
    const ctx1 = makeErrorCtx({ statusCode: 429, sessionId: 'cross' });
    await pipeline2.run(ctx1);
    assert.equal(ctx1.retry?.providerId, 'google');
    assert.equal(ctx1.retry?.model, 'gemini-2.0-flash');

    // Second fallback — different provider
    const ctx2 = makeErrorCtx({ statusCode: 429, sessionId: 'cross' });
    await pipeline2.run(ctx2);
    assert.equal(ctx2.retry?.providerId, 'anthropic');
    assert.equal(ctx2.retry?.model, 'claude-sonnet-4-20250514');
  });

  // -----------------------------------------------------------------------
  // Session isolation
  // -----------------------------------------------------------------------

  it('should maintain separate state per session', async () => {
    // Session A gets first fallback
    const ctxA = makeErrorCtx({ statusCode: 429, sessionId: 'sessA' });
    await pipeline.run(ctxA);
    assert.equal(ctxA.retry?.model, 'gemini-2.0-flash');

    // Session B also gets first fallback (independent chain)
    const ctxB = makeErrorCtx({ statusCode: 429, sessionId: 'sessB' });
    await pipeline.run(ctxB);
    assert.equal(ctxB.retry?.model, 'gemini-2.0-flash');

    // Session A gets second fallback
    const ctxA2 = makeErrorCtx({ statusCode: 429, sessionId: 'sessA' });
    await pipeline.run(ctxA2);
    assert.equal(ctxA2.retry?.model, 'gemini-2.0-flash-lite');

    // Session B still on second
    const ctxB2 = makeErrorCtx({ statusCode: 429, sessionId: 'sessB' });
    await pipeline.run(ctxB2);
    assert.equal(ctxB2.retry?.model, 'gemini-2.0-flash-lite');
  });

  // -----------------------------------------------------------------------
  // No config for provider
  // -----------------------------------------------------------------------

  it('should do nothing for providers without fallback config', async () => {
    const ctx = makeErrorCtx({
      providerId: 'anthropic',
      statusCode: 429,
    });
    await pipeline.run(ctx);

    assert.equal(ctx.retry, undefined);
  });

  // -----------------------------------------------------------------------
  // Metadata
  // -----------------------------------------------------------------------

  it('should populate metadata with fallback details', async () => {
    const ctx = makeErrorCtx({ statusCode: 429 });
    await pipeline.run(ctx);

    assert.equal(ctx.metadata.fallbackFrom, 'google:gemini-2.5-pro');
    assert.equal(ctx.metadata.fallbackTo, 'google:gemini-2.0-flash');
    assert.equal(ctx.metadata.fallbackIndex, 1);
    assert.equal(ctx.metadata.fallbackReason, 'HTTP 429');
  });

  // -----------------------------------------------------------------------
  // Custom trigger codes
  // -----------------------------------------------------------------------

  it('should respect custom trigger codes', async () => {
    const pipeline2 = new HookPipelineImpl();
    const { hook } = createFallbackHookWithState([
      {
        providerId: 'xai',
        fallbacks: ['grok-2'],
        triggerCodes: [500, 502, 503],
      },
    ]);
    pipeline2.register(hook);

    // 500 triggers
    const ctx500 = makeErrorCtx({ providerId: 'xai', statusCode: 500 });
    await pipeline2.run(ctx500);
    assert.ok(ctx500.retry);

    // 429 does NOT trigger (not in custom list)
    const ctx429 = makeErrorCtx({ providerId: 'xai', statusCode: 429 });
    await pipeline2.run(ctx429);
    assert.equal(ctx429.retry, undefined);
  });

  // -----------------------------------------------------------------------
  // Composability with other hooks
  // -----------------------------------------------------------------------

  it('should compose with logging hooks in the pipeline', async () => {
    const logEntries: string[] = [];

    pipeline.register({
      id: 'fallback-logger',
      event: 'provider:error',
      priority: 90, // Runs after fallback hook (priority 10)
      handler: async (ctx) => {
        const errCtx = ctx as ProviderErrorContext;
        if (errCtx.metadata.fallbackTo) {
          logEntries.push(`Fallback: ${errCtx.metadata.fallbackFrom} → ${errCtx.metadata.fallbackTo}`);
        }
      },
    });

    const ctx = makeErrorCtx({ statusCode: 429 });
    await pipeline.run(ctx);

    assert.equal(logEntries.length, 1);
    assert.equal(logEntries[0], 'Fallback: google:gemini-2.5-pro → google:gemini-2.0-flash');
  });
});
