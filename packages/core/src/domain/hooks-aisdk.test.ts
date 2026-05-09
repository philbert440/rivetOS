/**
 * hookPipelineToMiddleware — covers transformParams (provider:before) and
 * wrapStream (provider:after / provider:error) translation paths, including
 * skip/abort sentinel semantics, params reassignment, hasToolCalls detection,
 * usage mapping, and APICallError statusCode extraction.
 */

import { describe, it } from 'vitest'
import * as assert from 'node:assert/strict'
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import { HookPipelineImpl } from './hooks.js'
import { hookPipelineToMiddleware, HookSkipError } from './hooks-aisdk.js'
import type {
  ProviderAfterContext,
  ProviderBeforeContext,
  ProviderErrorContext,
} from '@rivetos/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeModel = {
  specificationVersion: 'v2',
  provider: 'fake',
  modelId: 'fake-model',
} as unknown as LanguageModelV2

function makeParams(
  overrides: Partial<LanguageModelV2CallOptions> = {},
): LanguageModelV2CallOptions {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...overrides,
  }
}

function streamFromParts(
  parts: LanguageModelV2StreamPart[],
): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p)
      controller.close()
    },
  })
}

async function drain(
  stream: ReadableStream<LanguageModelV2StreamPart>,
): Promise<LanguageModelV2StreamPart[]> {
  const out: LanguageModelV2StreamPart[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

// ---------------------------------------------------------------------------
// transformParams — provider:before mapping
// ---------------------------------------------------------------------------

describe('hookPipelineToMiddleware — transformParams', () => {
  it('builds provider:before context with binding fields', async () => {
    const pipeline = new HookPipelineImpl()
    let captured: ProviderBeforeContext | undefined

    pipeline.register({
      id: 'capture',
      event: 'provider:before',
      handler(ctx) {
        captured = ctx as ProviderBeforeContext
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
      agentId: 'phil',
      sessionId: 'session-123',
    })

    await mw.transformParams!({ type: 'stream', params: makeParams(), model: fakeModel })

    assert.equal(captured?.event, 'provider:before')
    assert.equal(captured?.providerId, 'xai')
    assert.equal(captured?.model, 'grok-4')
    assert.equal(captured?.agentId, 'phil')
    assert.equal(captured?.sessionId, 'session-123')
  })

  it('returns same params reference when hooks do not reassign', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'noop',
      event: 'provider:before',
      handler() {
        /* no-op */
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    const params = makeParams()
    const out = await mw.transformParams!({ type: 'stream', params, model: fakeModel })
    assert.equal(out, params)
  })

  it('propagates messages reassignment back into params.prompt', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'rewrite',
      event: 'provider:before',
      handler(ctx) {
        const c = ctx as ProviderBeforeContext
        c.messages = [
          ...(c.messages as LanguageModelV2CallOptions['prompt']),
          { role: 'system', content: 'extra' },
        ]
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    const params = makeParams()
    const out = await mw.transformParams!({ type: 'stream', params, model: fakeModel })

    assert.notEqual(out, params, 'params object should be cloned when prompt changes')
    assert.equal(out.prompt.length, 2)
    assert.equal(params.prompt.length, 1, 'original params.prompt unchanged')
  })

  it('propagates tools reassignment back into params.tools', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'tool-rewrite',
      event: 'provider:before',
      handler(ctx) {
        const c = ctx as ProviderBeforeContext
        c.tools = [
          {
            type: 'function',
            name: 'extra',
            inputSchema: { type: 'object' },
          },
        ]
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    const params = makeParams()
    const out = await mw.transformParams!({ type: 'stream', params, model: fakeModel })

    assert.equal(out.tools?.length, 1)
    assert.equal(
      (out.tools![0] as { name: string }).name,
      'extra',
    )
  })

  it('throws HookSkipError(skip-flag) when hook sets ctx.skip', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'gate',
      event: 'provider:before',
      handler(ctx) {
        ;(ctx as ProviderBeforeContext).skip = true
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    await assert.rejects(
      () => mw.transformParams!({ type: 'stream', params: makeParams(), model: fakeModel }),
      (err: unknown) => {
        assert.ok(err instanceof HookSkipError)
        assert.equal((err as HookSkipError).reason, 'skip-flag')
        assert.equal((err as HookSkipError).hookId, 'gate')
        return true
      },
    )
  })

  it('throws HookSkipError(aborted) when hook returns abort', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'abort-hook',
      event: 'provider:before',
      handler() {
        return 'abort'
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    await assert.rejects(
      () => mw.transformParams!({ type: 'stream', params: makeParams(), model: fakeModel }),
      (err: unknown) => {
        assert.ok(err instanceof HookSkipError)
        assert.equal((err as HookSkipError).reason, 'aborted')
        return true
      },
    )
  })

  it('throws HookSkipError(skipped) when hook returns skip', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'skip-hook',
      event: 'provider:before',
      handler() {
        return 'skip'
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    await assert.rejects(
      () => mw.transformParams!({ type: 'stream', params: makeParams(), model: fakeModel }),
      (err: unknown) => {
        assert.ok(err instanceof HookSkipError)
        assert.equal((err as HookSkipError).reason, 'skipped')
        return true
      },
    )
  })

  it('runs hooks in priority order so the highest-priority reassignment wins', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'late',
      event: 'provider:before',
      priority: 90,
      handler(ctx) {
        ;(ctx as ProviderBeforeContext).messages = [
          { role: 'system', content: 'late' },
        ]
      },
    })
    pipeline.register({
      id: 'early',
      event: 'provider:before',
      priority: 10,
      handler(ctx) {
        ;(ctx as ProviderBeforeContext).messages = [
          { role: 'system', content: 'early' },
        ]
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    const out = await mw.transformParams!({
      type: 'stream',
      params: makeParams(),
      model: fakeModel,
    })

    // Last hook to run (priority 90) reassigned last and wins.
    const text = (out.prompt[0] as { content: unknown }).content
    assert.equal(text, 'late')
  })
})

// ---------------------------------------------------------------------------
// wrapStream — provider:after / provider:error mapping
// ---------------------------------------------------------------------------

describe('hookPipelineToMiddleware — wrapStream', () => {
  it('runs provider:after after the stream finishes, with mapped usage + hasToolCalls=false', async () => {
    const pipeline = new HookPipelineImpl()
    let after: ProviderAfterContext | undefined
    pipeline.register({
      id: 'after',
      event: 'provider:after',
      handler(ctx) {
        after = ctx as ProviderAfterContext
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    const doStream = async () => ({
      stream: streamFromParts([
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'hello' },
        { type: 'text-end', id: 't1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
        },
      ]),
    })

    const wrapped = await mw.wrapStream!({
      doGenerate: (() => Promise.reject(new Error('not used'))) as never,
      doStream: doStream as never,
      params: makeParams(),
      model: fakeModel,
    })

    // Drain the wrapped stream to trigger flush() → provider:after.
    await drain(wrapped.stream)

    assert.ok(after, 'provider:after must fire')
    assert.equal(after?.providerId, 'xai')
    assert.equal(after?.model, 'grok-4')
    assert.equal(after?.hasToolCalls, false)
    assert.deepEqual(after?.usage, { promptTokens: 12, completionTokens: 7 })
    assert.ok(typeof after?.latencyMs === 'number' && after.latencyMs >= 0)
  })

  it('sets hasToolCalls=true when the stream contains a tool-call part', async () => {
    const pipeline = new HookPipelineImpl()
    let after: ProviderAfterContext | undefined
    pipeline.register({
      id: 'after',
      event: 'provider:after',
      handler(ctx) {
        after = ctx as ProviderAfterContext
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    const doStream = async () => ({
      stream: streamFromParts([
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'shell',
          input: '{}',
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        },
      ]),
    })

    const wrapped = await mw.wrapStream!({
      doGenerate: (() => Promise.reject(new Error('not used'))) as never,
      doStream: doStream as never,
      params: makeParams(),
      model: fakeModel,
    })

    await drain(wrapped.stream)

    assert.equal(after?.hasToolCalls, true)
  })

  it('runs provider:error when doStream rejects and re-throws the original error', async () => {
    const pipeline = new HookPipelineImpl()
    let errCtx: ProviderErrorContext | undefined
    pipeline.register({
      id: 'err',
      event: 'provider:error',
      handler(ctx) {
        errCtx = ctx as ProviderErrorContext
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    const boom = new Error('upstream exploded')
    const doStream = async () => {
      throw boom
    }

    await assert.rejects(
      () =>
        mw.wrapStream!({
          doGenerate: (() => Promise.reject(new Error('not used'))) as never,
          doStream: doStream as never,
          params: makeParams(),
          model: fakeModel,
        }),
      (err: unknown) => err === boom,
    )

    assert.ok(errCtx, 'provider:error must fire')
    assert.equal(errCtx?.error, boom)
    assert.equal(errCtx?.statusCode, undefined)
  })

  it('extracts statusCode from APICallError on provider:error', async () => {
    const pipeline = new HookPipelineImpl()
    let errCtx: ProviderErrorContext | undefined
    pipeline.register({
      id: 'err',
      event: 'provider:error',
      handler(ctx) {
        errCtx = ctx as ProviderErrorContext
      },
    })

    const mw = hookPipelineToMiddleware(pipeline, {
      providerId: 'xai',
      model: 'grok-4',
    })

    const apiErr = new APICallError({
      message: 'rate limited',
      url: 'https://api.x.ai/v1/responses',
      requestBodyValues: {},
      statusCode: 429,
    })
    const doStream = async () => {
      throw apiErr
    }

    await assert.rejects(
      () =>
        mw.wrapStream!({
          doGenerate: (() => Promise.reject(new Error('not used'))) as never,
          doStream: doStream as never,
          params: makeParams(),
          model: fakeModel,
        }),
      (err: unknown) => err === apiErr,
    )

    assert.equal(errCtx?.statusCode, 429)
  })
})
