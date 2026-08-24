/**
 * spawn-turn tests — argv assembly, the env scrub, and the child-exit latch.
 * No real dsh binary: a throwaway script stands in.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildArgs, buildChildEnv, KILL_GRACE_MS, spawnDshTui } from './spawn-turn.js'

describe('buildArgs', () => {
  it('assembles a fresh TUI session', () => {
    expect(buildArgs({ binary: 'dsh' })).toEqual(['--profile', 'tui'])
  })

  it('appends --resume after --profile tui', () => {
    expect(
      buildArgs({
        binary: 'dsh',
        resumeSessionId: 'session-86ffe759-cd7b-49a7-955d-c282631a935d',
      }),
    ).toEqual([
      '--profile',
      'tui',
      '--resume',
      'session-86ffe759-cd7b-49a7-955d-c282631a935d',
    ])
  })

  it('never pins a session id and never passes a model flag', () => {
    const args = buildArgs({
      binary: '/home/rivet/.local/bin/dsh',
      resumeSessionId: 'session-aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000',
    })
    expect(args).not.toContain('--session-id')
    expect(args).not.toContain('--session')
    expect(args).not.toContain('-S')
    expect(args).not.toContain('--model')
    expect(args).not.toContain('-m')
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('-p')
  })
})

describe('buildChildEnv', () => {
  it('applies overrides, deletes on undefined, and scrubs inherited DSH_HOME', () => {
    const previousHome = process.env.DSH_HOME
    const previousKey = process.env.RIVETOS_SESSION_KEY
    process.env.DSH_HOME = '/tmp/inherited-dsh'
    process.env.RIVETOS_SESSION_KEY = 'inherited'
    try {
      const env = buildChildEnv({ RIVETOS_TASK_ID: 't1', RIVETOS_SESSION_KEY: undefined })
      expect(env.RIVETOS_TASK_ID).toBe('t1')
      expect(env.RIVETOS_SESSION_KEY).toBeUndefined()
      expect(env.DSH_HOME).toBeUndefined()
    } finally {
      restore('DSH_HOME', previousHome)
      restore('RIVETOS_SESSION_KEY', previousKey)
    }
  })

  it('keeps an explicit DSH_HOME override', () => {
    const env = buildChildEnv({ DSH_HOME: '/tmp/dsh-home' })
    expect(env.DSH_HOME).toBe('/tmp/dsh-home')
  })
})

describe('waitExit', () => {
  it('resolves after a signal death whose close already fired', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexec sleep 60\n')
    const turn = spawnDshTui({ binary }, { killGraceMs: 50 })
    turn.kill()
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    await expect(turn.waitExit()).resolves.toBeNull()
  })

  it('resolves when the child closed BEFORE the first waitExit() call', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 7\n')
    const turn = spawnDshTui({ binary })
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    await expect(turn.waitExit()).resolves.toBe(7)
  })

  it('answers every concurrent caller', async () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const turn = spawnDshTui({ binary })
    await expect(Promise.all([turn.waitExit(), turn.waitExit()])).resolves.toEqual([0, 0])
  })

  it('spawns with the TUI argv, not a prompt flag', () => {
    const binary = fakeScript('#!/usr/bin/env bash\nexit 0\n')
    const turn = spawnDshTui({
      binary,
      resumeSessionId: 'session-86ffe759-cd7b-49a7-955d-c282631a935d',
    })
    expect(turn.args).toEqual([
      '--profile',
      'tui',
      '--resume',
      'session-86ffe759-cd7b-49a7-955d-c282631a935d',
    ])
    turn.kill()
  })
})

describe('KILL_GRACE_MS', () => {
  it('is a short TUI grace (no wire-flush budget)', () => {
    expect(KILL_GRACE_MS).toBeGreaterThanOrEqual(1_000)
    expect(KILL_GRACE_MS).toBeLessThanOrEqual(5_000)
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

function fakeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-spawn-'))
  scriptDirs.push(dir)
  const file = path.join(dir, 'dsh')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}
