import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import {
  GrokCliModel,
  buildUsage,
  composePrompt,
  effortFromProviderOptions,
  finishReasonFor,
  renderPromptForCli,
  type GrokCliModelConfig,
} from './grok-cli-model.js'

function fakeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-model-'))
  const file = path.join(dir, 'grok')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}

const prompt: LanguageModelV3Prompt = [
  { role: 'system', content: 'You are Maggie.' },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'hi' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'memory_search', input: { q: 'x' } },
    ],
  },
  {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'memory_search', output: { type: 'text', value: 'found' } }],
  },
  { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
]

function cfg(binary: string, extra: Partial<GrokCliModelConfig> = {}): GrokCliModelConfig {
  return {
    providerId: 'grok-cli',
    modelId: 'default',
    binary,
    permissionMode: 'dontAsk',
    reasoningEffort: undefined,
    maxTurns: 1,
    noPlan: true,
    systemPromptMode: 'prepend',
    allow: undefined,
    tools: undefined,
    cwd: undefined,
    agentId: 'maggie',
    ...extra,
  }
}

async function collect(model: GrokCliModel, p: LanguageModelV3Prompt): Promise<LanguageModelV3StreamPart[]> {
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

describe('renderPromptForCli / composePrompt', () => {
  it('splits system text from a USER/ASSISTANT/TOOL transcript', () => {
    const r = renderPromptForCli(prompt)
    expect(r.systemText).toBe('You are Maggie.')
    expect(r.userText).toContain('USER:\nhello')
    expect(r.userText).toContain('ASSISTANT:\nhi')
    expect(r.userText).toContain('ASSISTANT TOOL CALLS:\n  - memory_search({"q":"x"})')
    expect(r.userText).toContain('TOOL RESULT (memory_search):\nfound')
    expect(r.userText.endsWith('USER:\nand now?')).toBe(true)
  })

  it('prepend mode puts the system text into the prompt; override mode moves it to the flag', () => {
    const r = renderPromptForCli(prompt)
    const pre = composePrompt(r, 'prepend')
    expect(pre.prompt.startsWith('SYSTEM:\nYou are Maggie.')).toBe(true)
    expect(pre.systemPromptOverride).toBe('')
    const ovr = composePrompt(r, 'override')
    expect(ovr.prompt.startsWith('USER:')).toBe(true)
    expect(ovr.systemPromptOverride).toBe('You are Maggie.')
    const off = composePrompt(r, 'off')
    expect(off.prompt).not.toContain('SYSTEM:')
    expect(off.systemPromptOverride).toBe('')
  })

  it('never sends an empty -p argument', () => {
    expect(composePrompt({ systemText: '', userText: '' }, 'prepend').prompt).toBe('USER:\n(no message)')
  })
})

describe('helpers', () => {
  it('maps usage including cache and reasoning splits', () => {
    const u = buildUsage({
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, reasoning_tokens: 5 },
    })
    expect(u.inputTokens.total).toBe(100)
    expect(u.inputTokens.noCache).toBe(60)
    expect(u.outputTokens.reasoning).toBe(5)
    expect(u.outputTokens.text).toBe(15)
  })

  it('maps stop reasons', () => {
    expect(finishReasonFor('end_turn').unified).toBe('stop')
    expect(finishReasonFor('max_tokens').unified).toBe('length')
    expect(finishReasonFor('tool_use').unified).toBe('tool-calls')
    expect(finishReasonFor(undefined).unified).toBe('stop')
  })

  it('reads per-turn reasoning effort from providerOptions, else the fallback', () => {
    expect(effortFromProviderOptions({ 'grok-cli': { reasoningEffort: 'high' } }, 'low')).toBe('high')
    expect(effortFromProviderOptions({ 'grok-cli': { reasoningEffort: 'bogus' } }, 'low')).toBe('low')
    expect(effortFromProviderOptions(undefined, undefined)).toBeUndefined()
  })
})

describe('GrokCliModel.doStream', () => {
  it('replays reasoning, text and usage from the JSON result', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        'printf \'%s\' \'{"text":"PONG","thought":"thinking","stopReason":"end_turn","sessionId":"s1","usage":{"input_tokens":11,"output_tokens":4,"reasoning_tokens":1},"num_turns":1,"total_cost_usd":0.002}\'\n',
    )
    const parts = await collect(new GrokCliModel(cfg(bin)), prompt)
    const types = parts.map((p) => p.type)
    expect(types).toEqual([
      'stream-start',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ])
    const text = parts.find((p) => p.type === 'text-delta')
    expect(text && 'delta' in text ? text.delta : '').toBe('PONG')
    const fin = parts.find((p) => p.type === 'finish')
    if (!fin || fin.type !== 'finish') throw new Error('no finish')
    expect(fin.usage.inputTokens.total).toBe(11)
    expect(fin.finishReason.unified).toBe('stop')
    expect((fin.providerMetadata?.['grok-cli'] as { sessionId?: string }).sessionId).toBe('s1')
  })

  it('doGenerate accumulates the same call', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nprintf \'{"text":"gen","stopReason":"end_turn"}\'\n')
    const r = await new GrokCliModel(cfg(bin)).doGenerate({ prompt })
    expect(r.content).toEqual([{ type: 'text', text: 'gen' }])
  })

  it('receives the composed prompt as the -p argument and the system override flag', async () => {
    const bin = fakeScript(
      '#!/usr/bin/env bash\n' +
        'p="$2"; ovr=""; while [ $# -gt 0 ]; do if [ "$1" = "--system-prompt-override" ]; then ovr="$2"; fi; shift; done\n' +
        'node -e \'const [p,o]=process.argv.slice(1); process.stdout.write(JSON.stringify({text:p, thought:o}))\' "$p" "$ovr"\n',
    )
    const parts = await collect(new GrokCliModel(cfg(bin, { systemPromptMode: 'override' })), prompt)
    const text = parts.find((p) => p.type === 'text-delta')
    const reason = parts.find((p) => p.type === 'reasoning-delta')
    expect(text && 'delta' in text ? text.delta : '').toContain('USER:\nand now?')
    expect(text && 'delta' in text ? text.delta : '').not.toContain('SYSTEM:')
    expect(reason && 'delta' in reason ? reason.delta : '').toBe('You are Maggie.')
  })

  it('a non-zero exit without JSON becomes a stream error', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\necho "Error: --single: prompt is empty" >&2\nexit 2\n')
    const { stream } = await new GrokCliModel(cfg(bin)).doStream({ prompt })
    const reader = stream.getReader()
    const seen: string[] = []
    let threw = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        seen.push(value.type)
      }
    } catch {
      threw = true
    }
    expect(threw || seen.includes('error')).toBe(true)
    expect(seen).not.toContain('finish')
  })

  it('abort kills the child', async () => {
    const bin = fakeScript('#!/usr/bin/env bash\nexec sleep 60\n')
    const ac = new AbortController()
    const { stream } = await new GrokCliModel(cfg(bin)).doStream({ prompt, abortSignal: ac.signal })
    const reader = stream.getReader()
    const first = await reader.read()
    expect(first.value?.type).toBe('stream-start')
    const t0 = Date.now()
    ac.abort()
    let errored = false
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch {
      errored = true
    }
    expect(errored).toBe(true)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })
})
