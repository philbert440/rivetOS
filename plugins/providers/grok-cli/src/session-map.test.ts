import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  defaultSessionMapPath,
  loadSessionMap,
  saveSessionMap,
  uuidForConversation,
  SESSION_MAP_FILE,
} from './session-map.js'

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'grok-cli-map-'))
}

describe('session-map', () => {
  it('round-trips string entries and tolerates garbage', () => {
    const p = path.join(tmp(), 'map.json')
    expect(loadSessionMap(p)).toEqual({})
    saveSessionMap(p, { a: '1' })
    expect(loadSessionMap(p)).toEqual({ a: '1' })
    fs.writeFileSync(p, '{not json')
    expect(loadSessionMap(p)).toEqual({})
    fs.writeFileSync(p, JSON.stringify({ a: 1, b: 'ok', c: null }))
    expect(loadSessionMap(p)).toEqual({ b: 'ok' })
  })

  it('defaultSessionMapPath lives under ~/.rivetos', () => {
    expect(defaultSessionMapPath()).toBe(path.join(os.homedir(), '.rivetos', SESSION_MAP_FILE))
    expect(defaultSessionMapPath('other.json').endsWith(`${path.sep}other.json`)).toBe(true)
  })

  it('uuidForConversation is stable, v5-shaped, and key-dependent', () => {
    const id = uuidForConversation('default')
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(uuidForConversation('default')).toBe(id)
    expect(uuidForConversation('other')).not.toBe(id)
  })
})
