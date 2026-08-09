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
  spawnKimiTurn,
} from './spawn-turn.js'

describe('buildArgs', () => {
  it('assembles a fresh one-shot turn', () => {
    expect(buildArgs({ binary: 'kimi' }, 'do the thing')).toEqual([
      '--output-format',
      'stream-json',
      '-p',
      'do the thing',
    ])
  })

  it('adds -S for a resumed turn and -m for a model override', () => {
    const args = buildArgs(
      { binary: 'kimi', modelId: 'kimi-k3', resumeSessionId: 'session_abc' },
      'go on',
    )
    expect(args.slice(0, 4)).toEqual(['-S', 'session_abc', '-m', 'kimi-k3'])
    expect(args[args.length - 1]).toBe('go on')
  })

  it('never passes a permission flag — prompt mode rejects --auto/--yolo', () => {
    const args = buildArgs({ binary: 'kimi' }, 'x')
    expect(args).not.toContain('--auto')
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('--plan')
    // Flags kimi 0.34.0 simply does not have.
    expect(args).not.toContain('--append-system-prompt')
    expect(args).not.toContain('--mcp-config')
    expect(args).not.toContain('--json-schema')
    expect(args).not.toContain('--session-id')
  })
})

describe('clampPrompt', () => {
  it('leaves a normal prompt alone', () => {
    expect(clampPrompt('  hello  ')).toBe('hello')
  })

  it('substitutes a placeholder for an empty prompt (kimi rejects one)', () => {
    expect(clampPrompt('   ')).toBe(EMPTY_PROMPT_PLACEHOLDER)
  })

  it('clamps below the 128 KiB argv ceiling and says so', () => {
    const clamped = clampPrompt('y'.repeat(PROMPT_MAX_BYTES * 2))
    expect(Buffer.byteLength(clamped, 'utf8')).toBeLessThan(131_072)
    expect(clamped).toContain('prompt truncated by RivetOS')
  })

  it('clamps on BYTES, so a multi-byte prompt still fits the kernel limit', () => {
    // MAX_ARG_STRLEN counts bytes: 96k CHARACTERS of CJK is ~288 KiB and would
    // still E2BIG the spawn under a character-based clamp.
    const cjk = '漢'.repeat(PROMPT_MAX_BYTES)
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(131_072)
    const clamped = clampPrompt(cjk)
    expect(Buffer.byteLength(clamped, 'utf8')).toBeLessThan(131_072)
    expect(clamped).toContain('prompt truncated by RivetOS')
  })

  it('drops a character split by the cut rather than corrupting it', () => {
    // The clamp lands mid-sequence: a raw byte slice would decode to U+FFFD.
    const body = '漢'.repeat(PROMPT_MAX_BYTES) // 3 bytes each — 96_000 % 3 === 0
    const clamped = clampPrompt(`x${body}`) // the leading ASCII byte shifts the cut
    expect(clamped).not.toContain('\uFFFD')
  })
})

describe('buildChildEnv', () => {
  it('applies overrides, deletes on undefined, and scrubs the runner selectors', () => {
    const previousFormat = process.env.KIMI_MODEL_OUTPUT_FORMAT
    const previousLegacy = process.env.KIMI_CODE_LEGACY_FLAG
    const previousKey = process.env.RIVETOS_SESSION_KEY
    process.env.KIMI_MODEL_OUTPUT_FORMAT = 'text'
    process.env.KIMI_CODE_LEGACY_FLAG = '1'
    process.env.RIVETOS_SESSION_KEY = 'inherited'
    try {
      const env = buildChildEnv({ RIVETOS_TASK_ID: 't1', RIVETOS_SESSION_KEY: undefined })
      expect(env.RIVETOS_TASK_ID).toBe('t1')
      expect(env.RIVETOS_SESSION_KEY).toBeUndefined()
      // The env is only the FALLBACK for --output-format (kimi reads the flag
      // first), so with the flag always passed this cannot win today — it is
      // scrubbed so no future path that drops the flag can silently change
      // the output protocol.
      expect(env.KIMI_MODEL_OUTPUT_FORMAT).toBeUndefined()
      // The legacy flag selects the retired v1 print runner.
      expect(env.KIMI_CODE_LEGACY_FLAG).toBeUndefined()
    } finally {
      restore('KIMI_MODEL_OUTPUT_FORMAT', previousFormat)
      restore('KIMI_CODE_LEGACY_FLAG', previousLegacy)
      restore('RIVETOS_SESSION_KEY', previousKey)
    }
  })
})

describe('RESUME_REJECTED_RE', () => {
  it('matches both shapes kimi uses to refuse a -S session', () => {
    expect(RESUME_REJECTED_RE.test('Session "session_abc" not found.')).toBe(true)
    expect(
      RESUME_REJECTED_RE.test('Session "session_abc" was created under a different directory.'),
    ).toBe(true)
    expect(RESUME_REJECTED_RE.test('error: provider auth failed')).toBe(false)
  })
})

describe('waitExit', () => {
  it('resolves after a signal death whose close already fired', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexec sleep 60\n')
    const turn = spawnKimiTurn({ binary }, 'hi', { killGraceMs: 50 })
    turn.kill()
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    // The discriminating case, and the one the kill path actually takes: a
    // signalled child leaves `proc.exitCode` null forever, so the old
    // "already exited" shortcut never fires — and `close` is spent, so an
    // attach-on-demand listener never fires either. Both halves miss; the
    // promise used to hang.
    await expect(turn.waitExit()).resolves.toBeNull()
  })

  it('resolves when the child closed BEFORE the first waitExit() call', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 7\n')
    const turn = spawnKimiTurn({ binary }, 'hi')
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    // Listener attached after the fact: an attach-on-demand waitExit would
    // wait for a `close` that already happened.
    await expect(turn.waitExit()).resolves.toBe(7)
  })

  it('answers every concurrent caller', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const turn = spawnKimiTurn({ binary }, 'hi')
    await expect(Promise.all([turn.waitExit(), turn.waitExit()])).resolves.toEqual([0, 0])
  })
})

describe('KILL_GRACE_MS', () => {
  it('outlasts kimi’s own cleanup budget', () => {
    // PROMPT_CLEANUP_TIMEOUT_MS = 8_000 in kimi 0.34.0; SIGKILLing sooner
    // throws away the killed turn's last wire.jsonl batch.
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

/** A throwaway executable standing in for the kimi binary. */
function fakeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-spawn-'))
  scriptDirs.push(dir)
  const file = path.join(dir, 'kimi')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
