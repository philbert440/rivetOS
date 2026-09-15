import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { Provider, RegistrationContext } from '@rivetos/types'
import {
  KILL_GRACE_MS,
  QwenCodeModel,
  QwenCodeProvider,
  buildArgs,
  defaultQwenBinary,
  loadSessionMap,
  manifest,
  parseQwenLine,
  promptFromV3,
  saveSessionMap,
  systemFromV3,
} from './index.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-code-'))
}
function fakeScript(body: string): string {
  const file = path.join(tmp(), 'qwen')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
const prompt: LanguageModelV3Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'first' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
]
async function collect(
  model: QwenCodeModel,
  p: LanguageModelV3Prompt,
): Promise<LanguageModelV3StreamPart[]> {
  const { stream } = await model.doStream({ prompt: p })
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}
function model(
  binary: string,
  mapPath: string,
  extra?: {
    spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
    conversationId?: string
    randomUUID?: () => string
    cwd?: string
    modelId?: string
  },
): QwenCodeModel {
  return new QwenCodeModel({
    providerId: 'qwen-code',
    modelId: extra?.modelId ?? '',
    binary,
    cwd: extra?.cwd,
    conversationId: extra?.conversationId ?? 'conv-1',
    sessionMapPath: mapPath,
    spawnImpl: extra?.spawnImpl,
    randomUUID: extra?.randomUUID,
  })
}

const SID = '857b4b7d-3d13-4281-a648-11947cf530ed'

/** Compact real-shaped stream-json (from samples/headless-stream-json-partial.ndjson). */
function streamJsonLines(opts: { text?: string; thinking?: string } = {}): string {
  const text = opts.text ?? 'pong'
  const thinking = opts.thinking ?? 'The user is asking me to reply with pong.'
  return [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      uuid: SID,
      session_id: SID,
      cwd: '/home/example/scratchpad/proj',
      model: 'qwen-27b',
      permission_mode: 'yolo',
      qwen_code_version: '0.23.4',
    }),
    JSON.stringify({
      type: 'stream_event',
      uuid: 'a',
      session_id: SID,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'b',
      session_id: SID,
      message: {
        id: 'b',
        type: 'message',
        role: 'assistant',
        model: 'qwen-27b',
        content: [{ type: 'thinking', thinking, signature: '' }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
    JSON.stringify({
      type: 'stream_event',
      uuid: 'c',
      session_id: SID,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'd',
      session_id: SID,
      message: {
        id: 'd',
        type: 'message',
        role: 'assistant',
        model: 'qwen-27b',
        content: [{ type: 'text', text }],
        stop_reason: null,
        usage: {
          input_tokens: 24319,
          output_tokens: 39,
          cache_read_input_tokens: 0,
          total_tokens: 24358,
        },
      },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      uuid: 'e',
      session_id: SID,
      is_error: false,
      result: text,
      usage: {
        input_tokens: 34751,
        output_tokens: 208,
        cache_read_input_tokens: 0,
        total_tokens: 34959,
      },
    }),
  ]
    .map((l) => `echo ${JSON.stringify(l)}`)
    .join('\n')
}

const text = (parts: LanguageModelV3StreamPart[]): string =>
  parts
    .filter((p) => p.type === 'text-delta')
    .map((p) => ('delta' in p ? p.delta : ''))
    .join('')
const reason = (parts: LanguageModelV3StreamPart[]): string =>
  parts
    .filter((p) => p.type === 'reasoning-delta')
    .map((p) => ('delta' in p ? p.delta : ''))
    .join('')

describe('helpers', () => {
  it('promptFromV3 → newest user text; empty prompt gets the placeholder in args', () => {
    expect(promptFromV3(prompt)).toBe('hello')
    expect(defaultQwenBinary({})).toBe('qwen')
    expect(defaultQwenBinary({ QWEN_BINARY: '/x/qwen' })).toBe('/x/qwen')
    expect(buildArgs({ binary: 'qwen' }, '')).toEqual([
      '-p',
      '(no instruction was provided for this turn)',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--approval-mode',
      'yolo',
    ])
    expect(buildArgs({ binary: 'qwen', modelId: 'qwen-27b', pinSessionId: 's' }, 'q')).toEqual([
      '-p',
      'q',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--approval-mode',
      'yolo',
      '--session-id',
      's',
      '-m',
      'qwen-27b',
    ])
    expect(buildArgs({ binary: 'qwen', sessionId: 's' }, 'q')).toEqual([
      '-p',
      'q',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--approval-mode',
      'yolo',
      '--resume',
      's',
    ])
    expect(buildArgs({ binary: 'qwen', appendSystemPrompt: 'You are Rivet.' }, 'q')).toEqual([
      '-p',
      'q',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--approval-mode',
      'yolo',
      '--append-system-prompt',
      'You are Rivet.',
    ])
    expect(
      systemFromV3([
        { role: 'system', content: 'sys-a' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', content: 'sys-b' },
      ]),
    ).toBe('sys-a\n\nsys-b')
  })

  it('parseQwenLine classifies init, deltas, assistant snapshots, usage, tools, result', () => {
    expect(
      parseQwenLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: SID })),
    ).toEqual([{ kind: 'init', sessionId: SID }])
    expect(
      parseQwenLine(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'p' } },
        }),
      ),
    ).toEqual([{ kind: 'text', text: 'p' }])
    expect(
      parseQwenLine(
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'hmm' },
          },
        }),
      ),
    ).toEqual([{ kind: 'reasoning', text: 'hmm' }])
    expect(
      parseQwenLine(
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"q"' },
          },
        }),
      ),
    ).toEqual([{ kind: 'tool-input', delta: '{"q"' }])
    expect(
      parseQwenLine(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'call_abc',
                name: 'run_shell_command',
                input: { command: 'ls' },
              },
            ],
            usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 1 },
          },
        }),
      ),
    ).toEqual([
      { kind: 'usage', inputTokens: 10, outputTokens: 2, cacheRead: 1 },
      { kind: 'tool-call', id: 'call_abc', name: 'run_shell_command', input: { command: 'ls' } },
    ])
    expect(
      parseQwenLine(
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_abc', is_error: false, content: 'ok' },
            ],
          },
        }),
      ),
    ).toEqual([{ kind: 'tool-result', id: 'call_abc', result: 'ok', isError: false }])
    expect(
      parseQwenLine(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'pong',
          usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0 },
        }),
      ),
    ).toEqual([
      {
        kind: 'finish',
        isError: false,
        subtype: 'success',
        resultText: 'pong',
        usage: { inputTokens: 3, outputTokens: 1, cacheRead: 0 },
      },
    ])
    expect(parseQwenLine('No saved session found with ID ' + SID)).toEqual([
      { kind: 'resume-rejected' },
    ])
    expect(parseQwenLine('not json')).toEqual([{ kind: 'other' }])
  })
})

describe('QwenCodeModel.doStream', () => {
  it('replays stream-json text + reasoning deltas, usage from last non-zero assistant, pins --session-id first turn', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$0.argv"\n' + streamJsonLines(),
    )
    const mapPath = path.join(tmp(), 'map.json')
    const parts = await collect(
      model(bin, mapPath, { randomUUID: () => '11111111-1111-4111-8111-111111111111' }),
      prompt,
    )
    expect(text(parts)).toBe('pong')
    expect(reason(parts)).toBe('The user is asking me to reply with pong.')
    expect(loadSessionMap(mapPath)).toEqual({ 'conv-1': '11111111-1111-4111-8111-111111111111' })
    const argv = fs.readFileSync(`${bin}.argv`, 'utf8')
    expect(argv).toContain('--session-id')
    expect(argv).toContain('11111111-1111-4111-8111-111111111111')
    expect(argv).not.toContain('--resume')
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.finishReason.unified : '').toBe('stop')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.total : undefined).toBe(24319)
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : undefined).toBe(39)
  })

  it('passes --resume on the second turn of a conversation', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$0.argv"\n' + streamJsonLines(),
    )
    const mapPath = path.join(tmp(), 'map.json')
    saveSessionMap(mapPath, { 'conv-1': '22222222-2222-4222-8222-222222222222' })
    await collect(model(bin, mapPath), prompt)
    const argv = fs.readFileSync(`${bin}.argv`, 'utf8')
    expect(argv).toContain('--resume')
    expect(argv).toContain('22222222-2222-4222-8222-222222222222')
    expect(argv).not.toContain('--session-id')
  })

  it('does not replay assistant snapshot text when deltas already streamed', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\n' + streamJsonLines({ text: 'pong' }))
    const parts = await collect(model(bin, path.join(tmp(), 'map.json')), prompt)
    expect(text(parts)).toBe('pong')
  })

  it('falls back to assistant snapshot text when no deltas arrived', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        `echo '{"type":"system","subtype":"init","session_id":"${SID}"}'\n` +
        'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"PONG"}],"usage":{"input_tokens":4,"output_tokens":1}}}\'\n' +
        'echo \'{"type":"result","subtype":"success","is_error":false,"result":"PONG"}\'\n',
    )
    const parts = await collect(model(bin, path.join(tmp(), 'map.json')), prompt)
    expect(text(parts)).toBe('PONG')
  })

  it('passes system messages via --append-system-prompt', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$0.argv"\n' + streamJsonLines(),
    )
    const withSys: LanguageModelV3Prompt = [
      { role: 'system', content: 'You are Rivet.' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]
    await collect(model(bin, path.join(tmp(), 'map.json')), withSys)
    const argv = fs.readFileSync(`${bin}.argv`, 'utf8')
    expect(argv).toContain('--append-system-prompt')
    expect(argv).toContain('You are Rivet.')
  })

  it('spawns with stdin ignored and QWEN_CODE_SUPPRESS_YOLO_WARNING=1', async () => {
    let stdio: unknown
    let env: NodeJS.ProcessEnv | undefined
    const spawnImpl = ((command: string, args: readonly string[], options: SpawnOptions) => {
      stdio = options.stdio
      env = options.env as NodeJS.ProcessEnv
      return spawn(command, args as string[], options)
    }) as (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
    const bin = fakeScript('#!/usr/bin/env bash\n' + streamJsonLines())
    await collect(model(bin, path.join(tmp(), 'map.json'), { spawnImpl }), prompt)
    expect(stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(env?.QWEN_CODE_SUPPRESS_YOLO_WARNING).toBe('1')
  })

  it('resume-rejected (no system/init + No saved session found) drops the mapping and retries once with --session-id', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        'printf "%s\\n" "$@" >> "$0.argv.log"\n' +
        'if printf "%s\\n" "$@" | grep -q -- "--resume"; then\n' +
        '  echo "No saved session found with ID deadbeef-dead-4eef-8eef-deadbeefdead"\n' +
        '  exit 0\n' +
        'fi\n' +
        streamJsonLines({ text: 'recovered' }) +
        '\n',
    )
    const mapPath = path.join(tmp(), 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'deadbeef-dead-4eef-8eef-deadbeefdead' })
    let n = 0
    const parts = await collect(
      model(bin, mapPath, {
        randomUUID: () => {
          n += 1
          return `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${String(n)}`
        },
      }),
      prompt,
    )
    expect(text(parts)).toBe('recovered')
    const log = fs.readFileSync(`${bin}.argv.log`, 'utf8')
    expect(log).toContain('--resume')
    expect(log).toContain('--session-id')
    expect(loadSessionMap(mapPath)['conv-1']).toMatch(/^aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa/)
  })

  it('missing binary → error + finish(error)', async () => {
    const parts = await collect(model('/nonexistent/qwen', path.join(tmp(), 'm.json')), prompt)
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'error', 'finish'])
  })

  it('non-zero exit without output → bridge error text', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho nope >&2\nexit 2\n')
    const parts = await collect(model(bin, path.join(tmp(), 'm.json')), prompt)
    expect(text(parts)).toContain('qwen-code bridge error: nope')
  })

  it('emits tool-call from assistant tool_use blocks', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        `echo '{"type":"system","subtype":"init","session_id":"${SID}"}'\n` +
        'echo \'{"type":"assistant","message":{"content":[{"type":"tool_use","id":"call_6ef8c237955540faabb31812","name":"run_shell_command","input":{"command":"echo tool-sample-ok"}}],"usage":{"input_tokens":10,"output_tokens":2}}}\'\n' +
        'echo \'{"type":"result","subtype":"success","is_error":false,"result":""}\'\n',
    )
    const parts = await collect(model(bin, path.join(tmp(), 'map.json')), prompt)
    const tc = parts.find((p) => p.type === 'tool-call') as
      { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown } | undefined
    expect(tc?.toolCallId).toBe('call_6ef8c237955540faabb31812')
    expect(tc?.toolName).toBe('run_shell_command')
    expect(tc?.input).toEqual({ command: 'echo tool-sample-ok' })
  })
})

describe('provider + manifest', () => {
  it('defaults: model optional, context 262144, name = qwen-code', async () => {
    const p = new QwenCodeProvider({ binary: '/nonexistent/qwen' })
    expect(p.id).toBe('qwen-code')
    expect(p.name).toBe('qwen-code')
    expect(p.getModel()).toBe('')
    expect(p.getContextWindow()).toBe(262144)
    expect(p.getMaxOutputTokens()).toBe(8192)
    expect(await p.isAvailable()).toBe(false)
    expect(await p.isAvailable()).toBe(false)
  })

  it('isAvailable is true when qwen --version exits 0 with a semver (cached)', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho "0.23.4"\nexit 0\n')
    const p = new QwenCodeProvider({ binary: bin })
    expect(await p.isAvailable()).toBe(true)
    expect(await p.isAvailable()).toBe(true)
  })

  it('isAvailable is false when --version exits 0 without a semver', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho nope\nexit 0\n')
    const p = new QwenCodeProvider({ binary: bin })
    expect(await p.isAvailable()).toBe(false)
  })

  it('manifest registers from snake_case config; name defaults to qwen-code', () => {
    let registered: Provider | undefined
    const ctx = {
      pluginConfig: {
        model: 'qwen-27b',
        binary: '/x/qwen',
        home: '/x/.qwen',
        context_window: 128000,
      },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as RegistrationContext
    void manifest.register(ctx)
    expect(manifest.name).toBe('qwen-code')
    expect(registered?.getModel()).toBe('qwen-27b')
    expect(registered?.getContextWindow()).toBe(128000)
  })

  it('KILL_GRACE_MS is 3s like pi', () => {
    expect(KILL_GRACE_MS).toBe(3_000)
  })
})
