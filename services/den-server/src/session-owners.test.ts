import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionOwners } from './session-owners.js'
import type { UserContext } from '@rivetos/types'

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const coco: UserContext = {
  userId: 'coco',
  deviceId: 'win-coco',
  db: { pgUrl: 'postgres://coco@db/coco' },
  isOwner: false,
}
const owner: UserContext = {
  userId: 'owner',
  deviceId: null,
  db: { pgUrl: 'postgres://owner@db/rivet_memory' },
  isOwner: true,
}

describe('session owners', () => {
  it('treats untagged sessions as owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owners-'))
    dirs.push(dir)
    const owners = createSessionOwners(join(dir, 'session-owners.json'))
    expect(owners.visible('dead-owner-session', owner)).toBe(true)
    expect(owners.visible('dead-owner-session', coco)).toBe(false)
  })

  it('persists coco ownership and hides the row from the owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owners-'))
    dirs.push(dir)
    const file = join(dir, 'session-owners.json')
    const owners = createSessionOwners(file)
    owners.set('abc', 'coco')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ abc: 'coco' })
    const reloaded = createSessionOwners(file)
    expect(reloaded.visible('abc', coco)).toBe(true)
    expect(reloaded.visible('abc', owner)).toBe(false)
    expect(reloaded.filter([{ id: 'abc' }, { id: 'untagged' }], coco).map((s) => s.id)).toEqual([
      'abc',
    ])
  })

  it('a nested row follows its parent instead of the node owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owners-'))
    dirs.push(dir)
    const owners = createSessionOwners(join(dir, 'session-owners.json'))
    owners.set('parent', 'coco')
    expect(owners.visible('child', coco, 'parent')).toBe(true)
    expect(owners.visible('child', owner, 'parent')).toBe(false)
    expect(owners.visible('child', owner, 'untagged-parent')).toBe(true)
    expect(owners.visible('child', coco, 'untagged-parent')).toBe(false)
    expect(owners.inherit('child', 'parent')).toBe(true)
    expect(owners.get('child')).toBe('coco')
    expect(owners.inherit('child', 'someone-else')).toBe(false)
    expect(owners.get('child')).toBe('coco')
    const rows = [{ id: 'child', parentId: 'parent' }]
    expect(
      owners.filter(rows, coco, undefined, (row) => row.parentId).map((row) => row.id),
    ).toEqual(['child'])
    expect(owners.filter(rows, owner, undefined, (row) => row.parentId)).toEqual([])
  })
})
