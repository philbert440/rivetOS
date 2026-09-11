/**
 * spawn-turn tests — argv assembly, the prompt clamp, the env scrub, and the
 * child-exit latch. Turn translation is exercised through the executor's fake
 * binary; only the exit latch needs a real child here, because the states it
 * has to survive (signal death, a close that already fired) cannot be faked.
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
  spawnOpencodeTurn,
  variantForEffort,
} from './spawn-turn.js'

describe('buildArgs', () => {
  it('assembles a fresh one-shot turn', () => {
    expect(buildArgs({ binary: 'opencode' }, 'do the thing')).toEqual([
      'run',
      '--format',
      'json',
      'do the thing',
    ])
  })

  it('adds --session, --model and --variant', () => {
    const args = buildArgs(
      {
        binary: 'opencode',
        modelId: 'zai/glm-5.3-flash',
        resumeSessionId: 'ses_abcabcabcabcabcabcab',
        effort: 'low',
      },
      'go on',
    )
    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'zai/glm-5.3-flash',
      '--variant',
      'minimal',
      '--session',
      'ses_abcabcabcabcabcabcab',
      'go on',
    ])
  })

  it('omits --variant for medium effort', () => {
    const args = buildArgs({ binary: 'opencode', effort: 'medium' }, 'x')
    expect(args).not.toContain('--variant')
  })

  it('never passes ACP or last-session flags', () => {
    const args = buildArgs({ binary: 'opencode' }, 'x')
    expect(args).not.toContain('--continue')
    expect(args).not.toContain('--attach')
    expect(args).not.toContain('acp')
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('--auto')
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('--json-schema')
  })
})

describe('variantForEffort', () => {
  it('maps RivetOS ids onto OpenCode --variant values', () => {
    expect(variantForEffort('low')).toBe('minimal')
    expect(variantForEffort('medium')).toBeUndefined()
    expect(variantForEffort('high')).toBe('high')
    expect(variantForEffort('xhigh')).toBe('max')
    expect(variantForEffort('max')).toBe('max')
    expect(variantForEffort('nope')).toBeUndefined()
    expect(variantForEffort(undefined)).toBeUndefined()
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
  it('applies overrides, deletes on undefined', () => {
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
  it('matches the known Session-not-found class', () => {
    expect(RESUME_REJECTED_RE.test('Session not found')).toBe(true)
    expect(RESUME_REJECTED_RE.test('Error: session ses_abc not found')).toBe(true)
    expect(RESUME_REJECTED_RE.test('error: provider auth failed')).toBe(false)
  })
})

describe('waitExit', () => {
  it('resolves after a signal death whose close already fired', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexec sleep 60\n')
    const turn = spawnOpencodeTurn({ binary }, 'hi', { killGraceMs: 50 })
    turn.kill()
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    await expect(turn.waitExit()).resolves.toBeNull()
  })

  it('resolves when the child closed BEFORE the first waitExit() call', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 7\n')
    const turn = spawnOpencodeTurn({ binary }, 'hi')
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    await expect(turn.waitExit()).resolves.toBe(7)
  })

  it('answers every concurrent caller', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const turn = spawnOpencodeTurn({ binary }, 'hi')
    await expect(Promise.all([turn.waitExit(), turn.waitExit()])).resolves.toEqual([0, 0])
  })
})

describe('KILL_GRACE_MS', () => {
  it('is long enough that a SIGKILL does not race the last storage write', () => {
    expect(KILL_GRACE_MS).toBeGreaterThanOrEqual(8_000)
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

/** A throwaway executable standing in for the opencode binary. */
function fakeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-spawn-'))
  scriptDirs.push(dir)
  const file = path.join(dir, 'opencode')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
