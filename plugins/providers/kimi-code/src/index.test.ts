import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import type { Provider, RegistrationContext } from '@rivetos/types'
import { KimiCodeModel, KimiCodeProvider, buildArgs, loadSessionMap, manifest, parseKimiLine, promptFromV3, saveSessionMap } from './index.js'

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
})

describe('provider + manifest', () => {
  it('defaults', async () => {
    const p = new KimiCodeProvider({ binary: '/nonexistent/kimi' })
    expect(p.id).toBe('kimi-code')
    expect(p.getModel()).toBe('moonshotai/kimi-k3')
    expect(await p.isAvailable()).toBe(false)
  })
  it('manifest registers from snake_case config incl. home', () => {
    let registered: Provider | undefined
    const ctx = {
      pluginConfig: { model: 'kimi-k2', binary: '/x/kimi', home: '/x/.kimi', context_window: 128000 },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as RegistrationContext
    void manifest.register(ctx)
    expect(manifest.name).toBe('kimi-code')
    expect(registered?.getModel()).toBe('kimi-k2')
    expect(registered?.getContextWindow()).toBe(128000)
  })
})
