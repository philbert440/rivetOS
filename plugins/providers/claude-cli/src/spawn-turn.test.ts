/**
 * spawn-turn tests — the child-exit latch.
 *
 * `waitExit()` used to attach its `close` listener on demand and shortcut on
 * `proc.exitCode !== null`. Both halves miss a real terminal state: a child
 * that closed before the first call never re-emits `close`, and a child killed
 * by a signal leaves `exitCode` null forever. Either way the promise never
 * settles, and the executor's `result` — which must resolve on every terminal
 * path — hangs with it. These pin the latch that replaced it.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { spawnClaudeTurn } from './spawn-turn.js'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
})

/** A throwaway executable standing in for the claude binary. */
function fakeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spawn-'))
  dirs.push(dir)
  const file = path.join(dir, 'claude')
  fs.writeFileSync(file, body, { mode: 0o755 })
  return file
}

function spawnFake(body: string) {
  return spawnClaudeTurn(
    {
      binary: fakeScript(body),
      modelId: '',
      toolsArg: '',
      effort: 'low',
      permissionMode: 'default',
      excludeDynamicSections: false,
      systemText: '',
    },
    'hi',
  )
}

describe('spawnClaudeTurn waitExit', () => {
  it('resolves after a signal death whose close already fired', async () => {
    const turn = spawnFake('#!/usr/bin/env bash\ncat > /dev/null\nexec sleep 60\n')
    turn.kill()
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    // The discriminating case: a signalled child leaves `proc.exitCode` null
    // forever, so the old "already exited" shortcut never fired — and `close`
    // is spent, so an attach-on-demand listener never fired either.
    await expect(turn.waitExit()).resolves.toBeNull()
  })

  it('resolves when the child closed BEFORE the first waitExit() call', async () => {
    const turn = spawnFake('#!/usr/bin/env bash\ncat > /dev/null\nexit 7\n')
    await new Promise<void>((resolve) => turn.proc.once('close', () => resolve()))
    await expect(turn.waitExit()).resolves.toBe(7)
  })

  it('answers every concurrent caller', async () => {
    const turn = spawnFake('#!/usr/bin/env bash\ncat > /dev/null\nexit 0\n')
    await expect(Promise.all([turn.waitExit(), turn.waitExit()])).resolves.toEqual([0, 0])
  })
})
