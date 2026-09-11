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
  return new PiCliModel({ providerId: 'pi-cli', modelId: 'k', binary, cwd: undefined, piHome: '/tmp/pi-home', conversationId: 'conv-1', sessionMapPath: mapPath })
}
const text = (parts: LanguageModelV3StreamPart[]): string =>
  parts.filter((p) => p.type === 'text-delta').map((p) => ('delta' in p ? p.delta : '')).join('')

describe('helpers', () => {
  it('promptFromV3 → newest user text; empty prompt gets the placeholder in args', () => {
    expect(promptFromV3(prompt)).toBe('hello')
    expect(buildArgs({ binary: 'k' }, '')).toEqual(['-p', '(no instruction was provided for this turn)', '--mode', 'json'])
    expect(buildArgs({ binary: 'k', modelId: 'm', sessionId: 's' }, 'q')).toEqual(['-p', 'q', '--mode', 'json', '--model', 'm', '--session', 's'])
  })
  it('parsePiLine classifies assistant text, session ids and noise', () => {
    expect(parsePiLine(JSON.stringify({ type: 'text', text: 'hi' }))).toEqual({ kind: 'text', text: 'hi' })
    expect(parsePiLine(JSON.stringify({ type: 'session', sessionId: 'session_1' }))).toEqual({ kind: 'session', sessionId: 'session_1' })
    expect(parsePiLine(JSON.stringify({ type: 'text', text: '' }))).toEqual({ kind: 'other' })
    expect(parsePiLine('not json')).toEqual({ kind: 'other' })
  })
})

describe('PiCliModel.doStream', () => {
  it('replays text lines as text, remembers the session id, sets PI_HOME', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        'echo \'{"type":"session","sessionId":"session_42"}\'\n' +
        'echo \'{"type":"text","text":"PO"}\'\n' +
        'printf \'{"type":"text","text":"NG-\'"$PI_HOME"\'"}\'\n',
    )
    const mapPath = path.join(tmp(), 'map.json')
    const parts = await collect(model(bin, mapPath), prompt)
    expect(text(parts)).toBe('PONG-/tmp/pi-home')
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
    expect(p.getModel()).toBe('glm-5.3-flash')
    expect(await p.isAvailable()).toBe(false)
  })
  it('manifest registers from snake_case config incl. home', () => {
    let registered: Provider | undefined
    const ctx = {
      pluginConfig: { model: 'glm-5.3-flash', binary: '/x/pi', home: '/x/.pi', context_window: 128000 },
      registerProvider: (p: Provider) => {
        registered = p
      },
    } as unknown as RegistrationContext
    void manifest.register(ctx)
    expect(manifest.name).toBe('pi-cli')
    expect(registered?.getModel()).toBe('glm-5.3-flash')
    expect(registered?.getContextWindow()).toBe(128000)
  })
})
