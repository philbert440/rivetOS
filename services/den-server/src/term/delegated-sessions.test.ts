import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DelegatedSessionLink } from '@rivetos/types'
import { createSessionOwners } from '../session-owners.js'
import {
  applyDelegatedNesting,
  chainDepth,
  NEST_DEPTH_CAP,
  stampDelegatedOwners,
  verifyDelegatedClaims,
  type DelegatedClaimCheck,
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

  it('a 2-cycle and a self-parent stay flat', () => {
    const cycle: DelegatedSessionLink[] = [
      { taskId: 'a', parentTaskId: 'b', spawnedSessionId: 'sess-a' },
      { taskId: 'b', parentTaskId: 'a', spawnedSessionId: 'sess-b' },
    ]
    const byTask = new Map(cycle.map((link) => [link.taskId, link]))
    // undefined, not a depth past the cap: the seen set stops the walk.
    expect(chainDepth(cycle[0]!, byTask)).toBeUndefined()
    expect(chainDepth(cycle[1]!, byTask)).toBeUndefined()
    const cycled = applyDelegatedNesting([session('sess-a'), session('sess-b')], cycle)
    expect(cycled.every((row) => row.parentSessionId === undefined)).toBe(true)

    const self: DelegatedSessionLink = {
      taskId: 'a',
      parentTaskId: 'a',
      spawnedSessionId: 'sess-a',
      parentSessionId: 'claude-code:sess-a',
    }
    expect(chainDepth(self, new Map([[self.taskId, self]]))).toBeUndefined()
    const [row] = applyDelegatedNesting([session('sess-a')], [self])
    expect(row?.parentSessionId).toBeUndefined()
    expect(row?.taskId).toBe('a')
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

describe('verifyDelegatedClaims', () => {
  const check = (tagged: Record<string, string>, tenancy = true): DelegatedClaimCheck => ({
    tenancy,
    nodeOwnerId: 'owner',
    ownerOf: (id) => tagged[id],
  })

  it('does not nest or tag a spec that claims another owner parent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delegated-claim-'))
    dirs.push(dir)
    const owners = createSessionOwners(join(dir, 'session-owners.json'))
    const links = verifyDelegatedClaims(
      [
        {
          taskId: 'task-1',
          spawnedSessionId: 'child',
          parentSessionId: 'claude-code:parent',
          owner: 'user-b',
          agentName: 'reviewer',
          harnessId: 'claude-code',
        },
      ],
      check({ parent: 'alice' }),
    )
    expect(links[0]).toEqual({
      taskId: 'task-1',
      spawnedSessionId: 'child',
      agentName: 'reviewer',
      harnessId: 'claude-code',
    })
    const rows = applyDelegatedNesting([session('parent'), session('child')], links)
    expect(rows.find((row) => row.id === 'child')?.parentSessionId).toBeUndefined()
    stampDelegatedOwners(owners, links)
    expect(owners.get('child')).toBeUndefined()
    expect(owners.get('claude-code:child')).toBeUndefined()
  })

  it('nests and tags a claim the parent registry owner confirms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'delegated-claim-ok-'))
    dirs.push(dir)
    const owners = createSessionOwners(join(dir, 'session-owners.json'))
    const links = verifyDelegatedClaims(
      [
        {
          taskId: 'task-1',
          spawnedSessionId: 'child',
          parentSessionId: 'claude-code:parent',
          owner: 'coco',
          agentName: 'reviewer',
          model: 'opus',
          harnessId: 'claude-code',
        },
      ],
      // Tagged under the native id only. The canonical parent still resolves.
      check({ parent: 'coco' }),
    )
    const rows = applyDelegatedNesting([session('parent'), session('child')], links)
    expect(rows.find((row) => row.id === 'child')).toMatchObject({
      parentSessionId: 'parent',
      taskId: 'task-1',
      agentName: 'reviewer',
      model: 'opus',
    })
    stampDelegatedOwners(owners, links)
    expect(owners.get('child')).toBe('coco')
    expect(owners.get('claude-code:child')).toBe('coco')
    expect(owners.get('child')).not.toBe('alice')
  })

  it('keeps a mismatched claim when tenancy is off', () => {
    const links = verifyDelegatedClaims(
      [
        {
          taskId: 'task-1',
          spawnedSessionId: 'child',
          parentSessionId: 'claude-code:parent',
          owner: 'user-b',
        },
      ],
      check({ parent: 'alice' }, false),
    )
    expect(links[0]?.parentSessionId).toBe('claude-code:parent')
    expect(links[0]?.owner).toBe('user-b')
    const rows = applyDelegatedNesting([session('parent'), session('child')], links)
    expect(rows.find((row) => row.id === 'child')?.parentSessionId).toBe('parent')
  })

  it('treats an absent owner as the node owner, not as a tenant', () => {
    const nodeOwned = verifyDelegatedClaims(
      [
        {
          taskId: 'task-1',
          spawnedSessionId: 'child',
          parentSessionId: 'claude-code:human',
        },
      ],
      check({ human: 'owner' }),
    )
    expect(nodeOwned[0]?.parentSessionId).toBe('claude-code:human')
    expect(nodeOwned[0]?.owner).toBe('owner')

    const tenantParent = verifyDelegatedClaims(
      [
        {
          taskId: 'task-2',
          spawnedSessionId: 'child',
          parentSessionId: 'claude-code:human',
        },
      ],
      check({ human: 'alice' }),
    )
    expect(tenantParent[0]?.parentSessionId).toBeUndefined()
    expect(tenantParent[0]?.owner).toBeUndefined()
  })

  it('nests a confirmed chain and drops a sibling that claims someone else', () => {
    const links = verifyDelegatedClaims(
      [
        {
          taskId: 'a',
          spawnedSessionId: 'sess-a',
          parentSessionId: 'claude-code:human',
          owner: 'coco',
        },
        {
          taskId: 'b',
          parentTaskId: 'a',
          spawnedSessionId: 'sess-b',
          owner: 'coco',
        },
        {
          taskId: 'c',
          parentTaskId: 'a',
          spawnedSessionId: 'sess-c',
          owner: 'mallory',
        },
      ],
      check({ human: 'coco' }),
    )
    const rows = applyDelegatedNesting(
      [session('human'), session('sess-a'), session('sess-b'), session('sess-c')],
      links,
    )
    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get('sess-a')?.parentSessionId).toBe('human')
    expect(byId.get('sess-b')?.parentSessionId).toBe('sess-a')
    expect(byId.get('sess-c')?.parentSessionId).toBeUndefined()
    const forged = links.find((link) => link.taskId === 'c')
    expect(forged?.owner).toBeUndefined()
    expect(forged?.parentTaskId).toBeUndefined()
  })

  it('a 2-cycle of claims stays flat', () => {
    const links = verifyDelegatedClaims(
      [
        { taskId: 'a', parentTaskId: 'b', spawnedSessionId: 'sess-a', owner: 'coco' },
        { taskId: 'b', parentTaskId: 'a', spawnedSessionId: 'sess-b', owner: 'coco' },
      ],
      check({}),
    )
    expect(
      links.every((link) => link.parentTaskId === undefined && link.owner === undefined),
    ).toBe(true)
  })
})
