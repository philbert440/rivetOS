import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { Provider, RegistrationContext } from '@rivetos/types'
import { PiCliModel, PiCliProvider, buildArgs, loadSessionMap, manifest, parsePiLine, promptFromV3, saveSessionMap } from './index.js'

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
function model(binary: string, mapPath: string): PiCliModel {
  return new PiCliModel({ providerId: 'pi-cli', modelId: 'k', binary, cwd: undefined, sessionDir: undefined, conversationId: 'conv-1', sessionMapPath: mapPath })
}
const text = (parts: LanguageModelV3StreamPart[]): string =>
  parts.filter((p) => p.type === 'text-delta').map((p) => ('delta' in p ? p.delta : '')).join('')
const reason = (parts: LanguageModelV3StreamPart[]): string =>
  parts.filter((p) => p.type === 'reasoning-delta').map((p) => ('delta' in p ? p.delta : '')).join('')

const SID = '01a090db-c402-71cb-a954-6066b9493630'

describe('helpers', () => {
  it('promptFromV3 → newest user text; empty prompt gets the placeholder in args', () => {
    expect(promptFromV3(prompt)).toBe('hello')
    expect(buildArgs({ binary: 'k' }, '')).toEqual([
      '--print',
      '--mode',
      'json',
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
      'q',
    ])
  })
  it('parsePiLine classifies session ids, assistant text/thinking, and noise', () => {
    expect(parsePiLine(JSON.stringify({ type: 'session', version: 3, id: SID }))).toEqual([
      { kind: 'session', sessionId: SID },
    ])
    expect(
      parsePiLine(
        JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hmm' },
              { type: 'text', text: 'hi' },
            ],
            usage: { input_tokens: 3, output_tokens: 1 },
          },
        }),
      ),
    ).toEqual([
      { kind: 'usage', inputTokens: 3, outputTokens: 1 },
      { kind: 'reasoning', text: 'hmm' },
      { kind: 'text', text: 'hi' },
    ])
    expect(parsePiLine(JSON.stringify({ type: 'text', text: '' }))).toEqual([{ kind: 'other' }])
    expect(parsePiLine('not json')).toEqual([{ kind: 'other' }])
  })
})

describe('PiCliModel.doStream', () => {
  it('replays message lines as text/reasoning and remembers the session id', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        `echo '{"type":"session","version":3,"id":"${SID}"}'\n` +
        'echo \'{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"plan"},{"type":"text","text":"PONG"}]}}\'\n',
    )
    const mapPath = path.join(tmp(), 'map.json')
    const parts = await collect(model(bin, mapPath), prompt)
    expect(text(parts)).toBe('PONG')
    expect(reason(parts)).toBe('plan')
    expect(loadSessionMap(mapPath)).toEqual({ 'conv-1': SID })
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.finishReason.unified : '').toBe('stop')
  })
  it('passes --session for a known session', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nprintf \'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\' "$*"\n')
    const mapPath = path.join(tmp(), 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'session_old' })
    expect(text(await collect(model(bin, mapPath), prompt))).toContain('--session session_old')
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
