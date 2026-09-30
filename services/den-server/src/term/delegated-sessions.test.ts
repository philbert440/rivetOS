import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DelegatedSessionLink } from '@rivetos/types'
import { createSessionOwners } from '../session-owners.js'
import {
  applyDelegatedNesting,
  NEST_DEPTH_CAP,
  stampDelegatedOwners,
} from './delegated-sessions.js'

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

const session = (id: string, parentSessionId?: string) => ({
  id,
  command: 'claude',
  title: id,
  updatedAt: 1,
  ...(parentSessionId ? { parentSessionId } : {}),
})

describe('applyDelegatedNesting', () => {
  it('nests a depth-1 task under the delegating session', () => {
    const links: DelegatedSessionLink[] = [
      {
        taskId: 'task-1',
        spawnedSessionId: 'child',
        parentSessionId: 'claude-code:parent',
        agentName: 'reviewer',
        model: 'opus',
      },
    ]
    const [parent, child] = applyDelegatedNesting([session('parent'), session('child')], links)
    expect(parent?.parentSessionId).toBeUndefined()
    expect(child).toMatchObject({
      parentSessionId: 'parent',
      taskId: 'task-1',
      agentName: 'reviewer',
      model: 'opus',
    })
  })

  it('leaves the child flat when the parent session is not in the list', () => {
    const [child] = applyDelegatedNesting(
      [session('child')],
      [
        {
          taskId: 'task-1',
          spawnedSessionId: 'child',
          parentSessionId: 'claude-code:gone',
          agentName: 'reviewer',
        },
      ],
    )
    expect(child?.parentSessionId).toBeUndefined()
    expect(child?.taskId).toBe('task-1')
  })

  it('nests a chain under the parent task session and flattens a missing middle', () => {
    const links: DelegatedSessionLink[] = [
      {
        taskId: 'a',
        spawnedSessionId: 'sess-a',
        parentSessionId: 'claude-code:human',
        agentName: 'reviewer',
      },
      {
        taskId: 'b',
        parentTaskId: 'a',
        spawnedSessionId: 'sess-b',
        agentName: 'reviewer',
      },
      {
        taskId: 'c',
        parentTaskId: 'missing',
        spawnedSessionId: 'sess-c',
      },
    ]
    const rows = applyDelegatedNesting(
      [session('human'), session('sess-a'), session('sess-b'), session('sess-c')],
      links,
    )
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get('sess-a')?.parentSessionId).toBe('human')
    expect(byId.get('sess-b')?.parentSessionId).toBe('sess-a')
    expect(byId.get('sess-c')?.parentSessionId).toBeUndefined()
    expect(byId.get('sess-c')?.taskId).toBe('c')
  })

  it('flattens a chain past the depth cap and keeps the one at the cap', () => {
    const links: DelegatedSessionLink[] = []
    const sessions = [session('human')]
    let parentTaskId: string | undefined
    for (let i = 1; i <= NEST_DEPTH_CAP + 1; i++) {
      const taskId = `t${String(i)}`
      const spawnedSessionId = `s${String(i)}`
      links.push({
        taskId,
        spawnedSessionId,
        ...(i === 1
          ? { parentSessionId: 'claude-code:human' }
          : { parentTaskId: parentTaskId ?? '' }),
      })
      sessions.push(session(spawnedSessionId))
      parentTaskId = taskId
    }
    const rows = applyDelegatedNesting(sessions, links)
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get(`s${String(NEST_DEPTH_CAP)}`)?.parentSessionId).toBe(
      `s${String(NEST_DEPTH_CAP - 1)}`,
    )
    expect(byId.get(`s${String(NEST_DEPTH_CAP + 1)}`)?.parentSessionId).toBeUndefined()
  })

  it('does not replace a subagent parent the store already recorded', () => {
    const [row] = applyDelegatedNesting(
      [session('child', 'real-parent')],
      [
        {
          taskId: 'task-1',
          spawnedSessionId: 'child',
          parentSessionId: 'claude-code:other',
        },
      ],
    )
    expect(row?.parentSessionId).toBe('real-parent')
    expect(row?.taskId).toBe('task-1')
  })
})

describe('stampDelegatedOwners', () => {
  it('tags the child for its owner on the native and canonical ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delegated-owners-'))
    dirs.push(dir)
    const owners = createSessionOwners(join(dir, 'session-owners.json'))
    const link: DelegatedSessionLink = {
      taskId: 'task-1',
      spawnedSessionId: 'child-sess',
      owner: 'coco',
      harnessId: 'claude-code',
    }
    stampDelegatedOwners(owners, [link])
    stampDelegatedOwners(owners, [{ ...link, owner: 'someone-else' }])
    const coco = {
      userId: 'coco',
      deviceId: 'win-coco',
      db: { pgUrl: 'postgres://coco@db/coco' },
      isOwner: false,
    }
    const node = {
      userId: 'owner',
      deviceId: null,
      db: { pgUrl: 'postgres://owner@db/rivet_memory' },
      isOwner: true,
    }
    expect(owners.get('child-sess')).toBe('coco')
    expect(owners.visible('child-sess', coco)).toBe(true)
    expect(owners.visible('claude-code:child-sess', coco)).toBe(true)
    expect(owners.visible('child-sess', node)).toBe(false)
    expect(owners.visible('claude-code:child-sess', node)).toBe(false)
  })
})
