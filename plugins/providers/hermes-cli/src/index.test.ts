import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { Provider, RegistrationContext } from '@rivetos/types'
import {
  HermesCliModel,
  HermesCliProvider,
  buildArgs,
  loadSessionMap,
  manifest,
  promptFromV3,
  saveSessionMap,
  sessionIdFromStderr,
} from './index.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-cli-'))
}
function fakeScript(body: string): string {
  const file = path.join(tmp(), 'hermes')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
const prompt: LanguageModelV3Prompt = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: [{ type: 'text', text: 'first' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'there' }] },
]
async function collect(model: HermesCliModel, p: LanguageModelV3Prompt): Promise<LanguageModelV3StreamPart[]> {
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
function model(binary: string, mapPath: string, conversationId = 'conv-1'): HermesCliModel {
  return new HermesCliModel({ providerId: 'hermes-cli', modelId: 'qwen-27b', binary, cwd: undefined, conversationId, sessionMapPath: mapPath })
}

describe('helpers', () => {
  it('promptFromV3 takes the newest user message, text parts joined', () => {
    expect(promptFromV3(prompt)).toBe('hello\nthere')
    expect(promptFromV3([])).toBe('')
  })
  it('buildArgs: quiet chat with model, cwd and resume', () => {
    expect(buildArgs({ binary: 'h' }, 'q')).toEqual(['chat', '-q', 'q', '-Q', '--yolo', '--cli'])
    expect(buildArgs({ binary: 'h', modelId: 'm', cwd: '/w', sessionId: 's1' }, '')).toEqual([
      'chat', '-q', '(empty)', '-Q', '--yolo', '--cli', '-m', 'm', '--in', '/w', '--resume', 's1',
    ])
  })
  it('sessionIdFromStderr', () => {
    expect(sessionIdFromStderr('noise\nsession_id: abc-123\n')).toBe('abc-123')
    expect(sessionIdFromStderr('nothing')).toBeUndefined()
  })
  it('session map round-trips and tolerates garbage', () => {
    const p = path.join(tmp(), 'map.json')
    expect(loadSessionMap(p)).toEqual({})
    saveSessionMap(p, { a: '1' })
    expect(loadSessionMap(p)).toEqual({ a: '1' })
    fs.writeFileSync(p, '{not json')
    expect(loadSessionMap(p)).toEqual({})
    fs.writeFileSync(p, JSON.stringify({ a: 1, b: 'ok' }))
    expect(loadSessionMap(p)).toEqual({ b: 'ok' })
  })
})

describe('HermesCliModel.doStream', () => {
  it('streams stdout as text and remembers the session id from stderr', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho "session_id: sess-9" >&2\nprintf "PONG"\n')
    const mapPath = path.join(tmp(), 'map.json')
    const parts = await collect(model(bin, mapPath), prompt)
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'text-start', 'text-delta', 'text-end', 'finish'])
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.finishReason.unified : '').toBe('stop')
    expect(loadSessionMap(mapPath)).toEqual({ 'conv-1': 'sess-9' })
  })
  it('passes --resume when the conversation already has a session', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nprintf "%s" "$*"\n')
    const mapPath = path.join(tmp(), 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'old-7' })
    const parts = await collect(model(bin, mapPath), prompt)
    const text = parts.filter((p) => p.type === 'text-delta').map((p) => ('delta' in p ? p.delta : '')).join('')
    expect(text).toContain('--resume old-7')
    expect(text).toContain('-q hello')
  })
  it('missing binary → error + finish(error)', async () => {
    const parts = await collect(model('/nonexistent/hermes', path.join(tmp(), 'm.json')), prompt)
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'error', 'finish'])
  })
  it('non-zero exit without output surfaces a bridge error line', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho boom >&2\nexit 3\n')
    const parts = await collect(model(bin, path.join(tmp(), 'm.json')), prompt)
    const text = parts.filter((p) => p.type === 'text-delta').map((p) => ('delta' in p ? p.delta : '')).join('')
    expect(text).toContain('bridge error')
    expect(text).toContain('boom')
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.finishReason.unified : '').toBe('error')
  })
  it('doGenerate accumulates text', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nprintf "a"; printf "b"\n')
    const r = await model(bin, path.join(tmp(), 'm.json')).doGenerate({ prompt })
    expect(r.content).toEqual([{ type: 'text', text: 'ab' }])
  })
})

describe('provider + manifest', () => {
  it('defaults and bridge', async () => {
    const p = new HermesCliProvider({ binary: '/nonexistent/hermes' })
    expect(p.id).toBe('hermes-cli')
    expect(p.getModel()).toBe('qwen-27b')
    expect(p.getContextWindow()).toBe(262_144)
    expect(await p.isAvailable()).toBe(false)
    const m = p.aiSdkBridge().getModel({ modelOverride: 'x', conversationId: 'c' }) as unknown as { modelId: string; provider: string }
    expect(m.modelId).toBe('x')
    expect(m.provider).toBe('hermes-cli')
    expect(p.aiSdkBridge().buildProviderOptions([], undefined)).toBeUndefined()
  })
  it('manifest registers from snake_case config', () => {
    let registered: Provider | undefined
    const ctx = {
      pluginConfig: { model: 'custom/qwen-27b', binary: '/x/hermes', context_window: '262144', max_output_tokens: 'nope' },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as RegistrationContext
    void manifest.register(ctx)
    expect(manifest.name).toBe('hermes-cli')
    expect(registered?.getModel()).toBe('custom/qwen-27b')
    expect(registered?.getContextWindow()).toBe(262_144)
    expect(registered?.getMaxOutputTokens()).toBe(81_920)
  })
})
