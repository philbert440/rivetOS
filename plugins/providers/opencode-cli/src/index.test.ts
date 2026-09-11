import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { Provider, RegistrationContext } from '@rivetos/types'
import {
  OpencodeCliModel,
  OpencodeCliProvider,
  buildArgs,
  defaultOpencodeBinary,
  isSessionNotFound,
  loadSessionMap,
  manifest,
  parseOpencodeLine,
  promptFromV3,
  saveSessionMap,
} from './index.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cli-'))
}
function fakeScript(body: string): string {
  const file = path.join(tmp(), 'opencode')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
const prompt: LanguageModelV3Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'first' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
]
async function collect(model: OpencodeCliModel, p: LanguageModelV3Prompt): Promise<LanguageModelV3StreamPart[]> {
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
function model(binary: string, mapPath: string): OpencodeCliModel {
  return new OpencodeCliModel({
    providerId: 'opencode-cli',
    modelId: 'k',
    binary,
    cwd: undefined,
    opencodeHome: '/tmp/opencode-home',
    conversationId: 'conv-1',
    sessionMapPath: mapPath,
  })
}
const text = (parts: LanguageModelV3StreamPart[]): string =>
  parts.filter((p) => p.type === 'text-delta').map((p) => ('delta' in p ? p.delta : '')).join('')

describe('helpers', () => {
  it('promptFromV3 → newest user text; empty prompt gets the placeholder in args', () => {
    expect(promptFromV3(prompt)).toBe('hello')
    expect(buildArgs({ binary: 'k' }, '')).toEqual([
      'run',
      '--format',
      'json',
      '(no instruction was provided for this turn)',
    ])
    expect(buildArgs({ binary: 'k', modelId: 'm', sessionId: 's', effort: 'low' }, 'q')).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'm',
      '--variant',
      'minimal',
      '--session',
      's',
      'q',
    ])
    expect(buildArgs({ binary: 'k', effort: 'medium' }, 'q')).not.toContain('--variant')
    expect(defaultOpencodeBinary({})).toBe('opencode')
  })
  it('parseOpencodeLine classifies assistant text, session ids, usage and noise', () => {
    expect(parseOpencodeLine(JSON.stringify({ type: 'text', text: 'hi' }))).toEqual({ kind: 'text', text: 'hi' })
    expect(
      parseOpencodeLine(JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'hi' } })),
    ).toEqual({ kind: 'text', text: 'hi', sessionId: 'ses_1' })
    expect(parseOpencodeLine(JSON.stringify({ type: 'session', sessionID: 'session_1' }))).toEqual({
      kind: 'session',
      sessionId: 'session_1',
    })
    expect(
      parseOpencodeLine(
        JSON.stringify({
          role: 'assistant',
          tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
        }),
      ).kind,
    ).toBe('usage')
    const step = parseOpencodeLine(
      JSON.stringify({
        type: 'step_finish',
        timestamp: 9,
        sessionID: 'ses_1',
        part: {
          type: 'step_finish',
          tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 1 } },
        },
      }),
    )
    expect(step.kind).toBe('usage')
    if (step.kind === 'usage') {
      expect(step.usage.inputTokens.total).toBe(14)
      expect(step.usage.inputTokens.cacheRead).toBe(3)
      expect(step.usage.inputTokens.cacheWrite).toBe(1)
      expect(step.usage.outputTokens.total).toBe(3)
    }
    expect(parseOpencodeLine(JSON.stringify({ type: 'step-start' }))).toEqual({ kind: 'other' })
    expect(parseOpencodeLine(JSON.stringify({ type: 'text', text: '' }))).toEqual({ kind: 'other' })
    expect(parseOpencodeLine('not json')).toEqual({ kind: 'other' })
  })
  it('isSessionNotFound', () => {
    expect(isSessionNotFound('Error: Session not found')).toBe(true)
    expect(isSessionNotFound('Error: session ses_abc not found')).toBe(true)
    expect(isSessionNotFound('error: provider auth failed')).toBe(false)
    expect(isSessionNotFound('ok')).toBe(false)
  })
})

describe('OpencodeCliModel.doStream', () => {
  it('replays text parts, remembers the session id, sets XDG_DATA_HOME', async () => {
    const bin = fakeScript(
      `#!/usr/bin/env bash
echo '{"type":"session","sessionID":"session_42"}'
echo '{"type":"text","part":{"text":"PO"}}'
printf '{"type":"text","text":"NG-'"$XDG_DATA_HOME"'"}'
`,
    )
    const mapPath = path.join(tmp(), 'map.json')
    const parts = await collect(model(bin, mapPath), prompt)
    expect(text(parts)).toBe('PONG-/tmp/opencode-home')
    expect(loadSessionMap(mapPath)).toEqual({ 'conv-1': 'session_42' })
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.finishReason.unified : '').toBe('stop')
  })
  it('passes --session for a known session', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nprintf \'{"type":"text","text":"%s"}\' "$*"\n')
    const mapPath = path.join(tmp(), 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'session_old' })
    expect(text(await collect(model(bin, mapPath), prompt))).toContain('--session session_old')
  })
  it('missing binary → error + finish(error)', async () => {
    const parts = await collect(model('/nonexistent/opencode', path.join(tmp(), 'm.json')), prompt)
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'error', 'finish'])
  })
  it('non-zero exit without output → bridge error text', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho nope >&2\nexit 2\n')
    const parts = await collect(model(bin, path.join(tmp(), 'm.json')), prompt)
    expect(text(parts)).toContain('opencode-cli bridge error: nope')
  })
  it('Session not found drops the mapped id so the next turn can create one', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho "Session not found" >&2\nexit 1\n')
    const mapPath = path.join(tmp(), 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'stale' })
    const parts = await collect(model(bin, mapPath), prompt)
    expect(text(parts)).toContain('Session not found')
    expect(loadSessionMap(mapPath)).toEqual({})
  })
  it('a non-session failure keeps the mapped id', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho "error: provider auth failed" >&2\nexit 1\n')
    const mapPath = path.join(tmp(), 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'keep-me' })
    await collect(model(bin, mapPath), prompt)
    expect(loadSessionMap(mapPath)).toEqual({ 'conv-1': 'keep-me' })
  })
  it('accumulates part.tokens across multiple step_finish lines', async () => {
    const bin = fakeScript(`#!/usr/bin/env bash
echo '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step_finish","tokens":{"input":10,"output":2,"reasoning":0,"cache":{"read":3,"write":0}}}}'
echo '{"type":"text","sessionID":"ses_1","part":{"text":"hi"}}'
echo '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step_finish","tokens":{"input":4,"output":1,"reasoning":1,"cache":{"read":0,"write":2}}}}'
`)
    const parts = await collect(model(bin, path.join(tmp(), 'm.json')), prompt)
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.total : undefined).toBe(19)
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : undefined).toBe(4)
    expect(text(parts)).toBe('hi')
  })
  it('spawns a PATH-resolved binary name without an existsSync gate', async () => {
    const dir = tmp()
    const bin = path.join(dir, 'opencode')
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env bash
echo '{"type":"text","sessionID":"ses_path","part":{"text":"from-path"}}'
`,
      { mode: 0o755 },
    )
    const prev = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${prev ?? ''}`
    try {
      const parts = await collect(model('opencode', path.join(tmp(), 'm.json')), prompt)
      expect(text(parts)).toBe('from-path')
    } finally {
      process.env.PATH = prev
    }
  })
  it('abort escalates SIGTERM to SIGKILL when the child ignores SIGTERM', async () => {
    const bin = fakeScript(`#!/usr/bin/env node
process.on('SIGTERM', () => {})
setInterval(() => {}, 1 << 30)
`)
    const ac = new AbortController()
    const m = model(bin, path.join(tmp(), 'm.json'))
    const { stream } = await m.doStream({ prompt, abortSignal: ac.signal })
    const reader = stream.getReader()
    const collected = (async () => {
      const parts: LanguageModelV3StreamPart[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
      }
      return parts
    })()
    ac.abort()
    const parts = await collected
    expect(parts.some((p) => p.type === 'finish')).toBe(true)
  }, 15_000)
})

describe('provider + manifest', () => {
  it('defaults', async () => {
    const p = new OpencodeCliProvider({ binary: '/nonexistent/opencode' })
    expect(p.id).toBe('opencode-cli')
    expect(p.getModel()).toBe('zai/glm-5.3-flash')
    expect(p.getContextWindow()).toBe(128_000)
    expect(await p.isAvailable()).toBe(false)
  })
  it('manifest registers from snake_case config incl. home', () => {
    let registered: Provider | undefined
    const ctx = {
      pluginConfig: { model: 'zai/glm-5.3-flash', binary: '/x/opencode', home: '/x/.opencode', context_window: 1000000 },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as RegistrationContext
    void manifest.register(ctx)
    expect(manifest.name).toBe('opencode-cli')
    expect(registered?.getModel()).toBe('zai/glm-5.3-flash')
    expect(registered?.getContextWindow()).toBe(1000000)
  })
})
