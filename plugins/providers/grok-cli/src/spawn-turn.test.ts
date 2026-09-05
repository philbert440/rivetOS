import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildArgs, parseGrokJson, spawnGrokTurn, type GrokSpawnFlags } from './spawn-turn.js'

const base: GrokSpawnFlags = {
  binary: 'grok',
  permissionMode: 'dontAsk',
  maxTurns: 1,
  noPlan: true,
  systemPromptOverride: '',
}

function fakeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-spawn-'))
  const file = path.join(dir, 'grok')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}

describe('buildArgs', () => {
  it('emits the headless json invocation with the prompt as an argument', () => {
    expect(buildArgs(base, 'hello')).toEqual([
      '-p',
      'hello',
      '--output-format',
      'json',
      '--permission-mode',
      'dontAsk',
      '--max-turns',
      '1',
      '--no-plan',
    ])
  })

  it('adds model, effort, system override, tools, allow rules and cwd when set', () => {
    const args = buildArgs(
      {
        ...base,
        modelId: 'grok-4.5',
        reasoningEffort: 'high',
        systemPromptOverride: 'You are Maggie.',
        tools: 'read_file',
        allow: ['Read', 'Grep'],
        cwd: '/tmp/w',
        noPlan: false,
        maxTurns: 5,
      },
      'q',
    )
    expect(args).not.toContain('--no-plan')
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', 'grok-4.5'])
    expect(args).toContain('--reasoning-effort')
    expect(args[args.indexOf('--system-prompt-override') + 1]).toBe('You are Maggie.')
    expect(args[args.indexOf('--tools') + 1]).toBe('read_file')
    expect(args.filter((a) => a === '--allow')).toHaveLength(2)
    expect(args[args.indexOf('--cwd') + 1]).toBe('/tmp/w')
    expect(args[args.indexOf('--max-turns') + 1]).toBe('5')
  })
})

describe('parseGrokJson', () => {
  const sample = {
    text: 'PONG',
    thought: 'short',
    stopReason: 'end_turn',
    sessionId: 'abc',
    usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 4, reasoning_tokens: 1 },
    num_turns: 1,
    total_cost_usd: 0.001,
  }

  it('parses a clean pretty-printed object', () => {
    expect(parseGrokJson(JSON.stringify(sample, null, 2))).toEqual(sample)
  })

  it('tolerates trailing noise such as "Error: max turns reached"', () => {
    const out = `${JSON.stringify(sample, null, 2)}\nError: max turns reached\n`
    expect(parseGrokJson(out)?.text).toBe('PONG')
  })

  it('tolerates leading noise and braces inside strings', () => {
    const s = { ...sample, text: 'a { b } "c"' }
    const out = `warming up...\n${JSON.stringify(s)}\n`
    expect(parseGrokJson(out)?.text).toBe('a { b } "c"')
  })

  it('returns null when there is no object', () => {
    expect(parseGrokJson('')).toBeNull()
    expect(parseGrokJson('Error: something')).toBeNull()
    expect(parseGrokJson('{ not json')).toBeNull()
  })
})

describe('spawnGrokTurn', () => {
  it('collects stdout and resolves the exit code', async () => {
    const turn = spawnGrokTurn(
      { ...base, binary: fakeScript('#!/usr/bin/env bash\nprintf \'{"text":"hi","stopReason":"end_turn"}\'\nexit 0\n') },
      'q',
    )
    expect(await turn.waitExit()).toBe(0)
    expect(parseGrokJson(turn.stdoutText())?.text).toBe('hi')
  })

  it('surfaces a non-zero exit with stderr', async () => {
    const turn = spawnGrokTurn(
      { ...base, binary: fakeScript('#!/usr/bin/env bash\necho boom >&2\nexit 7\n') },
      'q',
    )
    expect(await turn.waitExit()).toBe(7)
    expect(turn.stderrText()).toContain('boom')
  })

  it('kill() ends a hung process', async () => {
    const turn = spawnGrokTurn({ ...base, binary: fakeScript('#!/usr/bin/env bash\nexec sleep 60\n') }, 'q')
    turn.kill()
    const code = await turn.waitExit()
    expect(code === null || code !== 0).toBe(true)
  })

  it('a missing binary resolves (does not throw) with a spawn error', async () => {
    const turn = spawnGrokTurn({ ...base, binary: '/nonexistent/grok-binary' }, 'q')
    expect(await turn.waitExit()).toBeNull()
    expect(turn.stderrText()).toContain('spawn error')
  })

  it('passes the prompt as the -p argument (no stdin)', async () => {
    const turn = spawnGrokTurn(
      { ...base, binary: fakeScript('#!/usr/bin/env bash\nprintf \'{"text":"%s"}\' "$2"\n') },
      'the prompt',
    )
    await turn.waitExit()
    expect(parseGrokJson(turn.stdoutText())?.text).toBe('the prompt')
  })
})
