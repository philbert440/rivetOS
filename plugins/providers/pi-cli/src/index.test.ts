import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { Provider, RegistrationContext } from '@rivetos/types'
import {
  KILL_GRACE_MS,
  PiCliModel,
  PiCliProvider,
  buildArgs,
  defaultPiBinary,
  loadSessionMap,
  manifest,
  parsePiLine,
  promptFromV3,
  saveSessionMap,
  systemFromV3,
} from './index.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-'))
}
function fakeScript(body: string): string {
  const file = path.join(tmp(), 'pi')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
const prompt: LanguageModelV3Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'first' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
]
async function collect(model: PiCliModel, p: LanguageModelV3Prompt): Promise<LanguageModelV3StreamPart[]> {
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
  extra?: { spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess },
): PiCliModel {
  return new PiCliModel({
    providerId: 'pi-cli',
    modelId: 'k',
    binary,
    cwd: undefined,
    sessionDir: undefined,
    conversationId: 'conv-1',
    sessionMapPath: mapPath,
    spawnImpl: extra?.spawnImpl,
  })
}

function runtimeStream(opts: {
  text?: string
  thinking?: string
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  stopReason?: string
}): string {
  const text = opts.text ?? 'PONG'
  const usage = opts.usage ?? { input: 3, output: 1, cacheRead: 2, cacheWrite: 0 }
  const stop = opts.stopReason ?? 'stop'
  const lines: string[] = [
    `echo '{"type":"session","version":3,"id":"${SID}"}'`,
    `echo '{"type":"agent_start"}'`,
    `echo '{"type":"turn_start"}'`,
  ]
  if (opts.thinking) {
    lines.push(
      `echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"${opts.thinking}"}}'`,
    )
  }
  const head = text.slice(0, 1)
  const rest = text.slice(1)
  if (head) {
    lines.push(
      `echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"${head}"}}'`,
    )
  }
  if (rest) {
    lines.push(
      `echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"${rest}"}}'`,
    )
  }
  lines.push(
    `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}],"usage":{"input":${String(usage.input)},"output":${String(usage.output)},"cacheRead":${String(usage.cacheRead ?? 0)},"cacheWrite":${String(usage.cacheWrite ?? 0)}},"stopReason":"${stop}"}}'`,
  )
  lines.push(`echo '{"type":"turn_end","message":{"role":"assistant","stopReason":"${stop}"}}'`)
  lines.push(`echo '{"type":"agent_settled"}'`)
  return lines.join('\n') + '\n'
}

async function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return pred()
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const text = (parts: LanguageModelV3StreamPart[]): string =>
  parts.filter((p) => p.type === 'text-delta').map((p) => ('delta' in p ? p.delta : '')).join('')
const reason = (parts: LanguageModelV3StreamPart[]): string =>
  parts.filter((p) => p.type === 'reasoning-delta').map((p) => ('delta' in p ? p.delta : '')).join('')

const SID = '01a090db-c402-71cb-a954-6066b9493630'

describe('helpers', () => {
  it('promptFromV3 → newest user text; empty prompt gets the placeholder in args', () => {
    expect(promptFromV3(prompt)).toBe('hello')
    expect(defaultPiBinary({})).toBe('pi')
    expect(defaultPiBinary({ PI_BINARY: '/x/pi' })).toBe('/x/pi')
    expect(buildArgs({ binary: 'k' }, '')).toEqual([
      '--print',
      '--mode',
      'json',
      '--',
      '(no instruction was provided for this turn)',
    ])
    expect(buildArgs({ binary: 'k', modelId: 'm', sessionId: 's' }, 'q')).toEqual([
      '--print',
      '--mode',
      'json',
      '--session',
      's',
      '--model',
      'm',
      '--',
      'q',
    ])
    expect(buildArgs({ binary: 'k' }, '-not-a-flag').slice(-2)).toEqual(['--', '-not-a-flag'])
    expect(buildArgs({ binary: 'k', appendSystemPrompt: 'You are Rivet.' }, 'q')).toEqual([
      '--print',
      '--mode',
      'json',
      '--append-system-prompt',
      'You are Rivet.',
      '--',
      'q',
    ])
    expect(systemFromV3([{ role: 'system', content: 'sys-a' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'system', content: 'sys-b' }])).toBe(
      'sys-a\n\nsys-b',
    )
  })
  it('parsePiLine classifies runtime session, deltas, usage, tools, finish', () => {
    expect(parsePiLine(JSON.stringify({ type: 'session', version: 3, id: SID }))).toEqual([
      { kind: 'session', sessionId: SID },
    ])
    expect(
      parsePiLine(
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'p' },
        }),
      ),
    ).toEqual([{ kind: 'text', text: 'p' }])
    expect(
      parsePiLine(
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
        }),
      ),
    ).toEqual([{ kind: 'reasoning', text: 'hmm' }])
    expect(
      parsePiLine(
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: { type: 'toolcall_end', id: 'Bash_0', name: 'Bash', arguments: { command: 'ls' } },
        }),
      ),
    ).toEqual([{ kind: 'tool-start', id: 'Bash_0', name: 'Bash', input: { command: 'ls' } }])
    expect(
      parsePiLine(
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'pong' }],
            usage: { input: 3, output: 1, cacheRead: 2, cacheWrite: 0 },
            stopReason: 'stop',
          },
        }),
      ),
    ).toEqual([
      { kind: 'usage', inputTokens: 5, outputTokens: 1, cacheRead: 2, cacheWrite: 0 },
      { kind: 'stop', stopReason: 'stop' },
      { kind: 'text-snapshot', text: 'pong' },
    ])
    expect(
      parsePiLine(
        JSON.stringify({
          type: 'message_end',
          message: { role: 'toolResult', toolCallId: 'Bash_0', toolName: 'Bash', content: [{ type: 'text', text: 'ok' }] },
        }),
      ),
    ).toEqual([{ kind: 'tool-result', id: 'Bash_0', name: 'Bash' }])
    expect(parsePiLine(JSON.stringify({ type: 'agent_settled' }))).toEqual([{ kind: 'finish' }])
    expect(parsePiLine(JSON.stringify({ type: 'text', text: '' }))).toEqual([{ kind: 'other' }])
    expect(parsePiLine('not json')).toEqual([{ kind: 'other' }])
    expect(
      parsePiLine(
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [], usage: { input_tokens: 4, output_tokens: 2 }, stopReason: 'stop' },
        }),
      ),
    ).toEqual([
      { kind: 'usage', inputTokens: 4, outputTokens: 2, cacheRead: 0, cacheWrite: 0 },
      { kind: 'stop', stopReason: 'stop' },
    ])
    // Disk `type:message` is a different format — not stdout.
    expect(
      parsePiLine(
        JSON.stringify({
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        }),
      ),
    ).toEqual([{ kind: 'other' }])
  })
})

describe('PiCliModel.doStream', () => {
  it('replays runtime deltas as text/reasoning, usage from message_end, and remembers the session id', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\n' + runtimeStream({ text: 'PONG', thinking: 'plan', usage: { input: 3, output: 1, cacheRead: 2 } }))
    const mapPath = path.join(tmp(), 'map.json')
    const parts = await collect(model(bin, mapPath), prompt)
    expect(text(parts)).toBe('PONG')
    expect(reason(parts)).toBe('plan')
    expect(loadSessionMap(mapPath)).toEqual({ 'conv-1': SID })
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.finishReason.unified : '').toBe('stop')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.total : undefined).toBe(5)
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : undefined).toBe(1)
  })
  it('does not replay message_end snapshot text when deltas already streamed', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\n' + runtimeStream({ text: 'PONG' }))
    const parts = await collect(model(bin, path.join(tmp(), 'map.json')), prompt)
    expect(text(parts)).toBe('PONG')
  })
  it('falls back to message_end snapshot text when no deltas arrived', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        `echo '{"type":"session","version":3,"id":"${SID}"}'\n` +
        'echo \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"PONG"}],"stopReason":"stop"}}\'\n' +
        'echo \'{"type":"agent_settled"}\'\n',
    )
    const parts = await collect(model(bin, path.join(tmp(), 'map.json')), prompt)
    expect(text(parts)).toBe('PONG')
  })
  it('passes --session for a known session', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        `echo '{"type":"session","version":3,"id":"${SID}"}'\n` +
        'echo "{\\"type\\":\\"message_update\\",\\"assistantMessageEvent\\":{\\"type\\":\\"text_delta\\",\\"contentIndex\\":0,\\"delta\\":\\"$*\\"}}"\n' +
        'echo \'{"type":"agent_settled"}\'\n',
    )
    const mapPath = path.join(tmp(), 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'session_old' })
    expect(text(await collect(model(bin, mapPath), prompt))).toContain('--session session_old')
  })
  it('passes system messages via --append-system-prompt', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        `echo '{"type":"session","version":3,"id":"${SID}"}'\n` +
        'echo "{\\"type\\":\\"message_update\\",\\"assistantMessageEvent\\":{\\"type\\":\\"text_delta\\",\\"contentIndex\\":0,\\"delta\\":\\"$*\\"}}"\n' +
        'echo \'{"type":"agent_settled"}\'\n',
    )
    const withSys: LanguageModelV3Prompt = [
      { role: 'system', content: 'You are Rivet.' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]
    const out = text(await collect(model(bin, path.join(tmp(), 'map.json')), withSys))
    expect(out).toContain('--append-system-prompt')
    expect(out).toContain('You are Rivet.')
  })
  it('spawns with stdin ignored', async () => {
    let stdio: unknown
    const spawnImpl = ((command: string, args: readonly string[], options: SpawnOptions) => {
      stdio = options.stdio
      return spawn(command, args as string[], options)
    }) as (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
    const bin = fakeScript('#!/usr/bin/env bash\n' + runtimeStream({ text: 'ok' }))
    await collect(model(bin, path.join(tmp(), 'map.json'), { spawnImpl }), prompt)
    expect(stdio).toEqual(['ignore', 'pipe', 'pipe'])
  })
  it('missing binary → error + finish(error)', async () => {
    const parts = await collect(model('/nonexistent/pi', path.join(tmp(), 'm.json')), prompt)
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'error', 'finish'])
  })
  it('non-zero exit without output → bridge error text', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho nope >&2\nexit 2\n')
    const parts = await collect(model(bin, path.join(tmp(), 'm.json')), prompt)
    expect(text(parts)).toContain('pi-cli bridge error: nope')
  })
  it('propagates stopReason aborted as an error', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\n' + runtimeStream({ text: 'nope', stopReason: 'aborted' }))
    const parts = await collect(model(bin, path.join(tmp(), 'm.json')), prompt)
    expect(parts.some((p) => p.type === 'error')).toBe(true)
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.finishReason.unified : '').toBe('error')
  })
  it('escalates abort SIGTERM to SIGKILL after 3s on a trap-TERM child', { timeout: 15_000 }, async () => {
    expect(KILL_GRACE_MS).toBe(3_000)
    const dir = tmp()
    const pidfile = path.join(dir, 'pid')
    const bin = fakeScript(
      `#!/usr/bin/env bash\ntrap '' TERM\necho $$ > ${JSON.stringify(pidfile)}\necho '{"type":"session","version":3,"id":"${SID}"}'\nwhile true; do sleep 1; done\n`,
    )
    const ac = new AbortController()
    const { stream } = await model(bin, path.join(dir, 'map.json')).doStream({ prompt, abortSignal: ac.signal })
    const reader = stream.getReader()
    expect(await waitFor(() => fs.existsSync(pidfile))).toBe(true)
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim())
    const t0 = Date.now()
    ac.abort()
    while (!(await reader.read()).done) {
      /* drain */
    }
    expect(await waitFor(() => !pidAlive(pid), 8_000)).toBe(true)
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThanOrEqual(2_000)
    expect(elapsed).toBeLessThan(10_000)
  })
  it('kills a SIGTERM-resistant child when the stream reader is cancelled', { timeout: 15_000 }, async () => {
    const dir = tmp()
    const pidfile = path.join(dir, 'pid')
    const bin = fakeScript(
      `#!/usr/bin/env bash\ntrap '' TERM\necho $$ > ${JSON.stringify(pidfile)}\necho '{"type":"session","version":3,"id":"${SID}"}'\nwhile true; do sleep 1; done\n`,
    )
    const { stream } = await model(bin, path.join(dir, 'map.json')).doStream({ prompt })
    const reader = stream.getReader()
    expect(await waitFor(() => fs.existsSync(pidfile))).toBe(true)
    await reader.read()
    const t0 = Date.now()
    await reader.cancel()
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim())
    expect(await waitFor(() => !pidAlive(pid), 8_000)).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_000)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })
})

describe('provider + manifest', () => {
  it('defaults', async () => {
    const p = new PiCliProvider({ binary: '/nonexistent/pi' })
    expect(p.id).toBe('pi-cli')
    expect(p.getModel()).toBe('deepseek/deepseek-v4-flash')
    expect(await p.isAvailable()).toBe(false)
    expect(await p.isAvailable()).toBe(false)
  })
  it('isAvailable is true when pi --version exits 0 (cached)', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const p = new PiCliProvider({ binary: bin })
    expect(await p.isAvailable()).toBe(true)
    expect(await p.isAvailable()).toBe(true)
  })
  it('manifest registers from snake_case config incl. home', () => {
    let registered: Provider | undefined
    const ctx = {
      pluginConfig: { model: 'deepseek/deepseek-v4-flash', binary: '/x/pi', home: '/x/.pi/agent', context_window: 128000 },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as RegistrationContext
    void manifest.register(ctx)
    expect(manifest.name).toBe('pi-cli')
    expect(registered?.getModel()).toBe('deepseek/deepseek-v4-flash')
    expect(registered?.getContextWindow()).toBe(128000)
  })
})
