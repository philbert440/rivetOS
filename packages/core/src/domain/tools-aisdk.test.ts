/**
 * toAiSdkTools — covers tool:before / tool:after firing, blocked-by-hook
 * short-circuit, args reassignment, error containment, plain-text vs.
 * multimodal toModelOutput, and the no-hooks path.
 */

import { describe, it } from 'vitest'
import * as assert from 'node:assert/strict'
import type {
  ContentPart,
  Tool as RivetosTool,
  ToolAfterContext,
  ToolBeforeContext,
} from '@rivetos/types'
import { HookPipelineImpl } from './hooks.js'
import { toAiSdkTools } from './tools-aisdk.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(
  name: string,
  execute: RivetosTool['execute'],
  description = `${name} description`,
): RivetosTool {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { x: { type: 'string' } },
    },
    execute,
  }
}

function execOpts(overrides: Partial<{ toolCallId: string; abortSignal: AbortSignal }> = {}) {
  return {
    toolCallId: overrides.toolCallId ?? 'tc-1',
    messages: [],
    abortSignal: overrides.abortSignal,
  }
}

// ---------------------------------------------------------------------------

describe('toAiSdkTools', () => {
  it('returns the underlying tool result as-is for string output', async () => {
    const tools = toAiSdkTools([
      makeTool('echo', async (args) => `got:${(args as { x: string }).x}`),
    ])
    const result = await tools.echo!.execute!({ x: 'hi' }, execOpts())
    assert.equal(result, 'got:hi')
  })

  it('passes input args through to underlying tool when no hooks present', async () => {
    let received: Record<string, unknown> | undefined
    const tools = toAiSdkTools([
      makeTool('capture', async (args) => {
        received = args
        return 'ok'
      }),
    ])
    await tools.capture!.execute!({ x: 'value' }, execOpts())
    assert.deepEqual(received, { x: 'value' })
  })

  it('fires tool:before with args copy and tool:after with result + duration', async () => {
    const pipeline = new HookPipelineImpl()
    const fired: Array<'before' | 'after'> = []
    let beforeArgs: Record<string, unknown> | undefined
    let afterResult: unknown
    let afterIsError: boolean | undefined
    let afterDuration: number | undefined

    pipeline.register({
      id: 'b',
      event: 'tool:before',
      handler: (ctx: ToolBeforeContext) => {
        fired.push('before')
        beforeArgs = ctx.args
      },
    })
    pipeline.register({
      id: 'a',
      event: 'tool:after',
      handler: (ctx: ToolAfterContext) => {
        fired.push('after')
        afterResult = ctx.result
        afterIsError = ctx.isError
        afterDuration = ctx.durationMs
      },
    })

    const tools = toAiSdkTools(
      [makeTool('echo', async () => 'done')],
      { hooks: pipeline },
    )
    const result = await tools.echo!.execute!({ x: 'hi' }, execOpts())

    assert.equal(result, 'done')
    assert.deepEqual(fired, ['before', 'after'])
    assert.deepEqual(beforeArgs, { x: 'hi' })
    assert.equal(afterResult, 'done')
    assert.equal(afterIsError, false)
    assert.equal(typeof afterDuration, 'number')
  })

  it('blocks tool execution when tool:before sets ctx.blocked', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'block',
      event: 'tool:before',
      handler: (ctx: ToolBeforeContext) => {
        ctx.blocked = true
        ctx.blockReason = 'no shells in tests'
      },
    })

    let executed = false
    const tools = toAiSdkTools(
      [
        makeTool('shell', async () => {
          executed = true
          return 'should not run'
        }),
      ],
      { hooks: pipeline },
    )
    const result = await tools.shell!.execute!({ x: 'rm -rf /' }, execOpts())

    assert.equal(executed, false)
    assert.equal(result, 'Blocked: no shells in tests')
  })

  it('uses default block reason when ctx.blockReason is unset', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'block',
      event: 'tool:before',
      handler: (ctx: ToolBeforeContext) => {
        ctx.blocked = true
      },
    })

    const tools = toAiSdkTools(
      [makeTool('shell', async () => 'ran')],
      { hooks: pipeline },
    )
    const result = await tools.shell!.execute!({}, execOpts())
    assert.equal(result, 'Blocked: Blocked by safety hook')
  })

  it('respects args reassignment from tool:before', async () => {
    const pipeline = new HookPipelineImpl()
    pipeline.register({
      id: 'rewrite',
      event: 'tool:before',
      handler: (ctx: ToolBeforeContext) => {
        ctx.args = { x: 'rewritten' }
      },
    })

    let received: Record<string, unknown> | undefined
    const tools = toAiSdkTools(
      [
        makeTool('capture', async (args) => {
          received = args
          return 'ok'
        }),
      ],
      { hooks: pipeline },
    )
    await tools.capture!.execute!({ x: 'original' }, execOpts())
    assert.deepEqual(received, { x: 'rewritten' })
  })

  it('catches thrown errors from tool.execute and returns "Error: <msg>"', async () => {
    const pipeline = new HookPipelineImpl()
    let afterIsError: boolean | undefined
    pipeline.register({
      id: 'observe',
      event: 'tool:after',
      handler: (ctx: ToolAfterContext) => {
        afterIsError = ctx.isError
      },
    })

    const tools = toAiSdkTools(
      [
        makeTool('boom', async () => {
          throw new Error('kaboom')
        }),
      ],
      { hooks: pipeline },
    )
    const result = await tools.boom!.execute!({}, execOpts())
    assert.equal(result, 'Error: kaboom')
    assert.equal(afterIsError, true)
  })

  it('passes abortSignal through to tool.execute', async () => {
    const ac = new AbortController()
    let received: AbortSignal | undefined
    const tools = toAiSdkTools([
      makeTool('check', async (_args, signal) => {
        received = signal
        return 'ok'
      }),
    ])
    await tools.check!.execute!({}, execOpts({ abortSignal: ac.signal }))
    assert.equal(received, ac.signal)
  })

  it('passes binding fields into ToolContext (agentId, workingDir, session)', async () => {
    let receivedAgent: string | undefined
    let receivedWorkdir: string | undefined
    let receivedSessionAgent: string | undefined
    const tools = toAiSdkTools(
      [
        makeTool('inspect', async (_args, _signal, ctx) => {
          receivedAgent = ctx?.agentId
          receivedWorkdir = ctx?.workingDir
          receivedSessionAgent = ctx?.session?.agentId
          return 'ok'
        }),
      ],
      { agentId: 'phil', workingDir: '/tmp/work', sessionId: 'sess-1' },
    )
    await tools.inspect!.execute!({}, execOpts())
    assert.equal(receivedAgent, 'phil')
    assert.equal(receivedWorkdir, '/tmp/work')
    assert.equal(receivedSessionAgent, 'phil')
  })

  it('toModelOutput: string result → text output', () => {
    const tools = toAiSdkTools([makeTool('t', async () => 'hello')])
    const out = tools.t!.toModelOutput!({
      toolCallId: 'tc-1',
      input: {},
      output: 'hello',
    })
    assert.deepEqual(out, { type: 'text', value: 'hello' })
  })

  it('toModelOutput: ContentPart[] without images → text output', () => {
    const tools = toAiSdkTools([makeTool('t', async () => [])])
    const result: ContentPart[] = [
      { type: 'text', text: 'one' },
      { type: 'text', text: ' two' },
    ]
    const out = tools.t!.toModelOutput!({
      toolCallId: 'tc-1',
      input: {},
      output: result,
    })
    assert.deepEqual(out, { type: 'text', value: 'one two' })
  })

  it('toModelOutput: ContentPart[] with image-data → content output', () => {
    const tools = toAiSdkTools([makeTool('t', async () => [])])
    const result: ContentPart[] = [
      { type: 'text', text: 'snap:' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]
    const out = tools.t!.toModelOutput!({
      toolCallId: 'tc-1',
      input: {},
      output: result,
    })
    assert.deepEqual(out, {
      type: 'content',
      value: [
        { type: 'text', text: 'snap:' },
        { type: 'image-data', data: 'aGVsbG8=', mediaType: 'image/png' },
      ],
    })
  })

  it('toModelOutput: image with url falls back to image-url, default mediaType for data', () => {
    const tools = toAiSdkTools([makeTool('t', async () => [])])
    const result: ContentPart[] = [
      { type: 'image', url: 'https://cdn.example.com/a.jpg' },
      { type: 'image', data: 'YWJjZA==' },
    ]
    const out = tools.t!.toModelOutput!({
      toolCallId: 'tc-1',
      input: {},
      output: result,
    })
    assert.deepEqual(out, {
      type: 'content',
      value: [
        { type: 'image-url', url: 'https://cdn.example.com/a.jpg' },
        { type: 'image-data', data: 'YWJjZA==', mediaType: 'image/jpeg' },
      ],
    })
  })

  it('isError detection on tool:after — "Error: …" text starts with Error', async () => {
    const pipeline = new HookPipelineImpl()
    let afterIsError: boolean | undefined
    pipeline.register({
      id: 'observe',
      event: 'tool:after',
      handler: (ctx: ToolAfterContext) => {
        afterIsError = ctx.isError
      },
    })
    const tools = toAiSdkTools(
      [makeTool('explicit', async () => 'Error: explicit failure')],
      { hooks: pipeline },
    )
    await tools.explicit!.execute!({}, execOpts())
    assert.equal(afterIsError, true)
  })

  it('returns a ToolSet with one entry per tool definition', () => {
    const tools = toAiSdkTools([
      makeTool('a', async () => 'x'),
      makeTool('b', async () => 'y'),
    ])
    assert.deepEqual(Object.keys(tools).sort(), ['a', 'b'])
    assert.equal(tools.a!.description, 'a description')
    assert.equal(tools.b!.description, 'b description')
  })
})
