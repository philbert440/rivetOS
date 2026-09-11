import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { Provider, RegistrationContext } from '@rivetos/types'
import { KimiCodeModel, KimiCodeProvider, buildArgs, extractKimiUsage, loadSessionMap, manifest, parseKimiLine, promptFromV3, saveSessionMap } from './index.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-code-'))
}
function fakeScript(body: string): string {
  const file = path.join(tmp(), 'kimi')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
const prompt: LanguageModelV3Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'first' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
]
async function collect(model: KimiCodeModel, p: LanguageModelV3Prompt): Promise<LanguageModelV3StreamPart[]> {
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
function model(binary: string, mapPath: string): KimiCodeModel {
  return new KimiCodeModel({ providerId: 'kimi-code', modelId: 'k', binary, cwd: undefined, kimiHome: '/tmp/kimi-home', conversationId: 'conv-1', sessionMapPath: mapPath })
}
const text = (parts: LanguageModelV3StreamPart[]): string =>
  parts.filter((p) => p.type === 'text-delta').map((p) => ('delta' in p ? p.delta : '')).join('')

describe('helpers', () => {
  it('promptFromV3 → newest user text; empty prompt gets the placeholder in args', () => {
    expect(promptFromV3(prompt)).toBe('hello')
    expect(buildArgs({ binary: 'k' }, '')).toEqual(['-p', '(no instruction was provided for this turn)', '--output-format', 'stream-json'])
    expect(buildArgs({ binary: 'k', modelId: 'm', sessionId: 's' }, 'q')).toEqual(['-p', 'q', '--output-format', 'stream-json', '-m', 'm', '-S', 's'])
  })
  it('parseKimiLine classifies assistant text, resume hints and noise', () => {
    expect(parseKimiLine(JSON.stringify({ role: 'assistant', content: 'hi' }))).toEqual({ kind: 'text', text: 'hi' })
    expect(parseKimiLine(JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'session_1' }))).toEqual({ kind: 'session', sessionId: 'session_1' })
    expect(parseKimiLine(JSON.stringify({ role: 'assistant', content: '' }))).toEqual({ kind: 'other' })
    expect(parseKimiLine('not json')).toEqual({ kind: 'other' })
  })
  it('parseKimiLine / extractKimiUsage read stream-json usage on assistant and result lines', () => {
    const wire = {
      role: 'assistant',
      content: 'hi',
      usage: { inputOther: 100, inputCacheRead: 20, inputCacheCreation: 5, output: 40 },
    }
    expect(parseKimiLine(JSON.stringify(wire))).toEqual({
      kind: 'text',
      text: 'hi',
      usage: {
        inputTokens: { total: 125, noCache: 100, cacheRead: 20, cacheWrite: 5 },
        outputTokens: { total: 40, text: 40, reasoning: undefined },
      },
    })
    expect(
      parseKimiLine(
        JSON.stringify({
          role: 'result',
          usage: { inputOther: 10, cacheRead: 2, cacheCreation: 1, output: 3 },
        }),
      ),
    ).toMatchObject({
      kind: 'usage',
      usage: {
        inputTokens: { total: 13, noCache: 10, cacheRead: 2, cacheWrite: 1 },
        outputTokens: { total: 3, text: 3 },
      },
    })
    expect(
      extractKimiUsage({ token: { inputOther: 1, output: 2 } })?.outputTokens.total,
    ).toBe(2)
    expect(extractKimiUsage({ role: 'assistant', content: 'x' })).toBeUndefined()
  })
})

describe('KimiCodeModel.doStream', () => {
  it('replays assistant lines as text, remembers the resume hint, sets KIMI_CODE_HOME', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        'echo \'{"role":"meta","type":"session.resume_hint","session_id":"session_42"}\'\n' +
        'echo \'{"role":"assistant","content":"PO"}\'\n' +
        'printf \'{"role":"assistant","content":"NG-\'"$KIMI_CODE_HOME"\'"}\'\n',
    )
    const mapPath = path.join(tmp(), 'map.json')
    const parts = await collect(model(bin, mapPath), prompt)
    expect(text(parts)).toBe('PONG-/tmp/kimi-home')
    expect(loadSessionMap(mapPath)).toEqual({ 'conv-1': 'session_42' })
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.finishReason.unified : '').toBe('stop')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.total : 0).toBeUndefined()
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : 0).toBeUndefined()
  })
  it('passes -S for a known session', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nprintf \'{"role":"assistant","content":"%s"}\' "$*"\n')
    const mapPath = path.join(tmp(), 'map.json')
    saveSessionMap(mapPath, { 'conv-1': 'session_old' })
    expect(text(await collect(model(bin, mapPath), prompt))).toContain('-S session_old')
  })
  it('missing binary → error + finish(error)', async () => {
    const parts = await collect(model('/nonexistent/kimi', path.join(tmp(), 'm.json')), prompt)
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'error', 'finish'])
  })
  it('non-zero exit without output → bridge error text', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho nope >&2\nexit 2\n')
    const parts = await collect(model(bin, path.join(tmp(), 'm.json')), prompt)
    expect(text(parts)).toContain('kimi-code bridge error: nope')
  })
  it('fills finish usage from the final assistant/result line', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        'echo \'{"role":"assistant","content":"ok","usage":{"inputOther":100,"inputCacheRead":20,"inputCacheCreation":5,"output":40}}\'\n',
    )
    const parts = await collect(model(bin, path.join(tmp(), 'map.json')), prompt)
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.usage : undefined).toEqual({
      inputTokens: { total: 125, noCache: 100, cacheRead: 20, cacheWrite: 5 },
      outputTokens: { total: 40, text: 40, reasoning: undefined },
    })
    expect(text(parts)).toBe('ok')
  })
  it('usage-only result line still reaches finish when it is last', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        'echo \'{"role":"assistant","content":"done"}\'\n' +
        'echo \'{"role":"result","token":{"inputOther":7,"output":2}}\'\n',
    )
    const parts = await collect(model(bin, path.join(tmp(), 'map.json')), prompt)
    const fin = parts.find((p) => p.type === 'finish')
    expect(fin && fin.type === 'finish' ? fin.usage.inputTokens.noCache : undefined).toBe(7)
    expect(fin && fin.type === 'finish' ? fin.usage.outputTokens.total : undefined).toBe(2)
  })
})

describe('provider + manifest', () => {
  it('defaults', async () => {
    const p = new KimiCodeProvider({ binary: '/nonexistent/kimi' })
    expect(p.id).toBe('kimi-code')
    expect(p.getModel()).toBe('moonshotai/kimi-k3')
    expect(p.getContextWindow()).toBe(256000)
    expect(p.getMaxOutputTokens()).toBe(8192)
    expect(await p.isAvailable()).toBe(false)
  })
  it('isAvailable probes --version, caches, and is false on non-zero', async () => {
    const missing = new KimiCodeProvider({ binary: '/nonexistent/kimi' })
    expect(await missing.isAvailable()).toBe(false)
    expect(await missing.isAvailable()).toBe(false)

    const ok = new KimiCodeProvider({ binary: fakeScript('#!/usr/bin/env bash\nexit 0\n') })
    expect(await ok.isAvailable()).toBe(true)
    expect(await ok.isAvailable()).toBe(true)

    const bad = new KimiCodeProvider({ binary: fakeScript('#!/usr/bin/env bash\nexit 1\n') })
    expect(await bad.isAvailable()).toBe(false)
  })
  it('manifest registers from snake_case config incl. home', () => {
    let registered: Provider | undefined
    const ctx = {
      pluginConfig: {
        model: 'kimi-k2',
        binary: '/x/kimi',
        home: '/x/.kimi',
        context_window: 128000,
        max_output_tokens: 4096,
      },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as RegistrationContext
    void manifest.register(ctx)
    expect(manifest.name).toBe('kimi-code')
    expect(registered?.getModel()).toBe('kimi-k2')
    expect(registered?.getContextWindow()).toBe(128000)
    expect(registered?.getMaxOutputTokens()).toBe(4096)
  })
  it('ignores non-positive context_window / max_output_tokens and keeps defaults', () => {
    let registered: Provider | undefined
    const ctx = {
      pluginConfig: { context_window: 0, max_output_tokens: -1 },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as RegistrationContext
    void manifest.register(ctx)
    expect(registered?.getContextWindow()).toBe(256000)
    expect(registered?.getMaxOutputTokens()).toBe(8192)
  })
})
