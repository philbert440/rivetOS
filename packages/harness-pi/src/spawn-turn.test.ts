/**
 * spawn-turn tests — argv assembly, the prompt clamp, the env override, and
 * the child-exit latch. Turn translation is exercised through the executor's
 * fake binary; only the exit latch needs a real child here, because the
 * states it has to survive (signal death, a close that already fired) cannot
 * be faked.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildArgs,
  buildChildEnv,
  clampPrompt,
  EMPTY_PROMPT_PLACEHOLDER,
  KILL_GRACE_MS,
  PROMPT_MAX_BYTES,
  RESUME_REJECTED_RE,
  spawnPiTurn,
} from './spawn-turn.js'

describe('buildArgs', () => {
  it('assembles a fresh one-shot print/JSON turn', () => {
    expect(buildArgs({ binary: 'pi' }, 'do the thing')).toEqual([
      '--print',
      '--mode',
      'json',
      '--',
      'do the thing',
    ])
  })

  it('puts the prompt after -- so a leading - or @ is not a flag or file include', () => {
    expect(buildArgs({ binary: 'pi' }, '-not-a-flag')).toEqual([
      '--print',
      '--mode',
      'json',
      '--',
      '-not-a-flag',
    ])
    expect(buildArgs({ binary: 'pi' }, '@notes.md').slice(-2)).toEqual(['--', '@notes.md'])
  })

  it('adds --session for a resumed turn, --model and --thinking when set', () => {
    const args = buildArgs(
      {
        binary: 'pi',
        modelId: 'deepseek/deepseek-v4-flash',
        resumeSessionId: '01a090db-c402-71cb-a954-6066b9493630',
        thinking: 'high',
      },
      'go on',
    )
    expect(args.slice(0, 9)).toEqual([
      '--print',
      '--mode',
      'json',
      '--session',
      '01a090db-c402-71cb-a954-6066b9493630',
      '--model',
      'deepseek/deepseek-v4-flash',
      '--thinking',
      'high',
    ])
    expect(args.slice(-2)).toEqual(['--', 'go on'])
  })

  it('passes --append-system-prompt when the scaffold is set', () => {
    expect(buildArgs({ binary: 'pi', appendSystemPrompt: '## Task Context' }, 'hi')).toEqual([
      '--print',
      '--mode',
      'json',
      '--append-system-prompt',
      '## Task Context',
      '--',
      'hi',
    ])
  })

  it('pins a new session with --session-id and optional --session-dir', () => {
    const args = buildArgs(
      {
        binary: 'pi',
        pinSessionId: '01a090db-c402-71cb-a954-6066b9493630',
        sessionDir: '/tmp/pi-sessions',
      },
      'hi',
    )
    expect(args).toEqual([
      '--print',
      '--mode',
      'json',
      '--session-id',
      '01a090db-c402-71cb-a954-6066b9493630',
      '--session-dir',
      '/tmp/pi-sessions',
      '--',
      'hi',
    ])
    expect(args).not.toContain('--session')
  })

  it('never passes a permission flag or kimi-shaped aliases', () => {
    const args = buildArgs({ binary: 'pi' }, 'x')
    expect(args).not.toContain('--auto')
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('--plan')
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--json-schema')
    expect(args).not.toContain('-S')
    expect(args).not.toContain('-p')
  })
})

describe('clampPrompt', () => {
  it('leaves a normal prompt alone', () => {
    expect(clampPrompt('  hello  ')).toBe('hello')
  })

  it('substitutes a placeholder for an empty prompt', () => {
    expect(clampPrompt('   ')).toBe(EMPTY_PROMPT_PLACEHOLDER)
  })

  it('clamps below the 128 KiB argv ceiling and says so', () => {
    const clamped = clampPrompt('y'.repeat(PROMPT_MAX_BYTES * 2))
    expect(Buffer.byteLength(clamped, 'utf8')).toBeLessThan(131_072)
    expect(clamped).toContain('prompt truncated by RivetOS')
  })

  it('clamps on BYTES, so a multi-byte prompt still fits the kernel limit', () => {
    const cjk = '漢'.repeat(PROMPT_MAX_BYTES)
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(131_072)
    const clamped = clampPrompt(cjk)
    expect(Buffer.byteLength(clamped, 'utf8')).toBeLessThan(131_072)
    expect(clamped).toContain('prompt truncated by RivetOS')
  })

  it('drops a character split by the cut rather than corrupting it', () => {
    const body = '漢'.repeat(PROMPT_MAX_BYTES)
    const clamped = clampPrompt(`x${body}`)
    expect(clamped).not.toContain('\uFFFD')
  })
})

describe('buildChildEnv', () => {
  it('applies overrides and deletes on undefined', () => {
    const previousKey = process.env.RIVETOS_SESSION_KEY
    process.env.RIVETOS_SESSION_KEY = 'inherited'
    try {
      const env = buildChildEnv({ RIVETOS_TASK_ID: 't1', RIVETOS_SESSION_KEY: undefined })
      expect(env.RIVETOS_TASK_ID).toBe('t1')
      expect(env.RIVETOS_SESSION_KEY).toBeUndefined()
    } finally {
      restore('RIVETOS_SESSION_KEY', previousKey)
    }
  })
})

describe('RESUME_REJECTED_RE', () => {
  it('matches the refuse shapes this executor treats as "start fresh"', () => {
    expect(RESUME_REJECTED_RE.test('Session "session_abc" not found.')).toBe(true)
    expect(
      RESUME_REJECTED_RE.test('Session "session_abc" was created under a different directory.'),
    ).toBe(true)
    expect(RESUME_REJECTED_RE.test('error: session not found')).toBe(true)
    expect(RESUME_REJECTED_RE.test('error: provider auth failed')).toBe(false)
  })
})

describe('stdin', () => {
  it('spawns with stdin ignored so print mode cannot block on an open pipe', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const turn = spawnPiTurn({ binary }, 'hi')
    expect(turn.proc.stdin).toBeNull()
    await expect(turn.waitExit()).resolves.toBe(0)
  })
})

describe('waitExit', () => {
  it('resolves after a signal death whose close already fired', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexec sleep 60\n')
    const turn = spawnPiTurn({ binary }, 'hi', { killGraceMs: 50 })
    turn.kill()
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    await expect(turn.waitExit()).resolves.toBeNull()
  })

  it('resolves when the child closed BEFORE the first waitExit() call', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 7\n')
    const turn = spawnPiTurn({ binary }, 'hi')
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    await expect(turn.waitExit()).resolves.toBe(7)
  })

  it('answers every concurrent caller', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const turn = spawnPiTurn({ binary }, 'hi')
    await expect(Promise.all([turn.waitExit(), turn.waitExit()])).resolves.toEqual([0, 0])
  })
})

describe('KILL_GRACE_MS', () => {
  it('leaves room for a print-mode transcript flush', () => {
    expect(KILL_GRACE_MS).toBeGreaterThanOrEqual(2_000)
  })
})

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const scriptDirs: string[] = []
afterAll(() => {
  for (const dir of scriptDirs) fs.rmSync(dir, { recursive: true, force: true })
})

/** A throwaway executable standing in for the pi binary. */
function fakeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-spawn-'))
  scriptDirs.push(dir)
  const file = path.join(dir, 'pi')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
