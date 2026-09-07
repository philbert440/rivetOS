import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findCodexRoomRollout } from './codex-room.js'

describe('Codex terminal room discovery', () => {
  let root: string
  let proc: string
  let sessions: string
  const filename = 'rollout-2026-09-07T17-50-11-01a07dd9-a82b-7ea2-83a0-45005097dd41.jsonl'
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-room-'))
    proc = join(root, 'proc')
    sessions = join(root, 'sessions')
    await mkdir(proc)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  async function processFile(pid: string, room: string, path: string, command = '/bin/codex') {
    const dir = join(proc, pid)
    await mkdir(join(dir, 'fd'), { recursive: true })
    await mkdir(join(dir, 'fdinfo'))
    await writeFile(join(dir, 'cmdline'), `${command}\0`)
    await writeFile(join(dir, 'environ'), `RIVET_DEN_SESSION=${room}\0`)
    await symlink(path, join(dir, 'fd', '61'))
    await writeFile(join(dir, 'fdinfo', '61'), 'flags:\t0102002\n')
  }
  it('uses the exact process room and an open rollout, excluding other rooms and commands', async () => {
    const path = join(sessions, '2026/09/07', filename)
    await processFile('1', 'other-room', join(sessions, 'other', filename))
    await processFile('2', 'room', path)
    await processFile('3', 'room', join(sessions, 'ignored', filename), '/bin/node')
    expect(await findCodexRoomRollout('room', sessions, proc)).toBe(path)
    expect(await findCodexRoomRollout('unknown', sessions, proc)).toBeUndefined()
  })
  it('rejects paths outside the store and ambiguous rooms', async () => {
    await processFile('1', 'room', join(root, 'elsewhere', filename))
    expect(await findCodexRoomRollout('room', sessions, proc)).toBeUndefined()
    await processFile('2', 'room', join(sessions, 'one', filename))
    await processFile('3', 'room', join(sessions, 'two', filename))
    expect(await findCodexRoomRollout('room', sessions, proc)).toBeUndefined()
  })
  it('ignores read-only history files before and after the active rollout opens', async () => {
    await processFile('1', 'room', join(sessions, 'history', filename))
    await writeFile(join(proc, '1', 'fdinfo', '61'), 'flags:\t0100000\n')
    expect(await findCodexRoomRollout('room', sessions, proc)).toBeUndefined()
    const active = join(sessions, 'active', filename)
    await processFile('2', 'room', active)
    expect(await findCodexRoomRollout('room', sessions, proc)).toBe(active)
  })
})
