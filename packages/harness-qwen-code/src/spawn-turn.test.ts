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
  spawnQwenTurn,
} from './spawn-turn.js'

describe('buildArgs', () => {
  it('assembles a fresh one-shot stream-json turn', () => {
    expect(buildArgs({ binary: 'qwen' }, 'do the thing')).toEqual([
      '-p',
      'do the thing',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--approval-mode',
      'yolo',
    ])
  })

  it('puts the prompt as the -p value so a leading - is still the prompt', () => {
    expect(buildArgs({ binary: 'qwen' }, '-not-a-flag')[1]).toBe('-not-a-flag')
    expect(buildArgs({ binary: 'qwen' }, '@notes.md')[1]).toBe('@notes.md')
  })

  it('adds --resume for a resumed turn and -m when set', () => {
    const args = buildArgs(
      {
        binary: 'qwen',
        modelId: 'qwen-27b',
        resumeSessionId: '857b4b7d-3d13-4281-a648-11947cf530ed',
      },
      'go on',
    )
    expect(args).toEqual([
      '-p',
      'go on',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--approval-mode',
      'yolo',
      '--resume',
      '857b4b7d-3d13-4281-a648-11947cf530ed',
      '-m',
      'qwen-27b',
    ])
  })

  it('passes --append-system-prompt when the scaffold is set', () => {
    expect(buildArgs({ binary: 'qwen', appendSystemPrompt: '## Task Context' }, 'hi')).toEqual([
      '-p',
      'hi',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--approval-mode',
      'yolo',
      '--append-system-prompt',
      '## Task Context',
    ])
  })

  it('pins a new session with --session-id and never also passes --resume', () => {
    const args = buildArgs(
      {
        binary: 'qwen',
        pinSessionId: '857b4b7d-3d13-4281-a648-11947cf530ed',
        resumeSessionId: '11111111-2222-4333-8444-555555555555',
        maxSessionTurns: 8,
      },
      'hi',
    )
    expect(args).toEqual([
      '-p',
      'hi',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--approval-mode',
      'yolo',
      '--session-id',
      '857b4b7d-3d13-4281-a648-11947cf530ed',
      '--max-session-turns',
      '8',
    ])
    expect(args).not.toContain('--resume')
  })

  it('never passes pi-shaped aliases or an effort flag', () => {
    const args = buildArgs({ binary: 'qwen' }, 'x')
    expect(args).not.toContain('--print')
    expect(args).not.toContain('--mode')
    expect(args).not.toContain('--thinking')
    expect(args).not.toContain('--effort')
    expect(args).not.toContain('--session')
    expect(args).not.toContain('--')
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
  it('applies overrides, deletes on undefined, and suppresses the yolo warning', () => {
    const previousKey = process.env.RIVETOS_SESSION_KEY
    process.env.RIVETOS_SESSION_KEY = 'inherited'
    try {
      const env = buildChildEnv({ RIVETOS_TASK_ID: 't1', RIVETOS_SESSION_KEY: undefined })
      expect(env.RIVETOS_TASK_ID).toBe('t1')
      expect(env.RIVETOS_SESSION_KEY).toBeUndefined()
      expect(env.QWEN_CODE_SUPPRESS_YOLO_WARNING).toBe('1')
    } finally {
      restore('RIVETOS_SESSION_KEY', previousKey)
    }
  })
})

describe('RESUME_REJECTED_RE', () => {
  it('matches the refuse shape this executor treats as "start fresh"', () => {
    expect(
      RESUME_REJECTED_RE.test(
        'No saved session found with ID 857b4b7d-3d13-4281-a648-11947cf530ed. Run `qwen --resume` to list available sessions.',
      ),
    ).toBe(true)
    expect(RESUME_REJECTED_RE.test('error: provider auth failed')).toBe(false)
  })
})

describe('stdin', () => {
  it('spawns with stdin ignored so qwen cannot block on an open pipe', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const turn = spawnQwenTurn({ binary }, 'hi')
    expect(turn.proc.stdin).toBeNull()
    await expect(turn.waitExit()).resolves.toBe(0)
  })
})

describe('waitExit', () => {
  it('resolves after a signal death whose close already fired', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexec sleep 60\n')
    const turn = spawnQwenTurn({ binary }, 'hi', { killGraceMs: 50 })
    turn.kill()
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    await expect(turn.waitExit()).resolves.toBeNull()
  })

  it('resolves when the child closed BEFORE the first waitExit() call', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 7\n')
    const turn = spawnQwenTurn({ binary }, 'hi')
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    await expect(turn.waitExit()).resolves.toBe(7)
  })

  it('answers every concurrent caller', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const turn = spawnQwenTurn({ binary }, 'hi')
    await expect(Promise.all([turn.waitExit(), turn.waitExit()])).resolves.toEqual([0, 0])
  })
})

describe('KILL_GRACE_MS', () => {
  it('leaves room for a transcript flush', () => {
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

/** A throwaway executable standing in for the qwen binary. */
function fakeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-spawn-'))
  scriptDirs.push(dir)
  const file = path.join(dir, 'qwen')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
