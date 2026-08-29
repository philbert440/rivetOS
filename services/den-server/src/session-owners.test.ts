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
const phil: UserContext = {
  userId: 'phil',
  deviceId: null,
  db: { pgUrl: 'postgres://phil@db/phil' },
  isOwner: true,
}

describe('session owners', () => {
  it('treats untagged sessions as owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owners-'))
    dirs.push(dir)
    const owners = createSessionOwners(join(dir, 'session-owners.json'))
    expect(owners.visible('dead-phil-session', phil)).toBe(true)
    expect(owners.visible('dead-phil-session', coco)).toBe(false)
  })

  it('persists coco ownership and hides the row from phil', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owners-'))
    dirs.push(dir)
    const file = join(dir, 'session-owners.json')
    const owners = createSessionOwners(file)
    owners.set('abc', 'coco')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ abc: 'coco' })
    const reloaded = createSessionOwners(file)
    expect(reloaded.visible('abc', coco)).toBe(true)
    expect(reloaded.visible('abc', phil)).toBe(false)
    expect(reloaded.filter([{ id: 'abc' }, { id: 'untagged' }], coco).map((s) => s.id)).toEqual([
      'abc',
    ])
  })
})
