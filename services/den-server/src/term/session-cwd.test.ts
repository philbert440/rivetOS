import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionCwdStore } from './session-cwd.js'

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'den-session-cwd-'))
  dirs.push(dir)
  return dir
}

describe('session cwd store', () => {
  it('set/get round-trips and does not create the file until the first set', () => {
    const dir = tmp()
    const file = join(dir, 'session-cwd.json')
    const store = createSessionCwdStore(file)
    expect(store.get('claude', 'a')).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
    store.set('claude', 'sess-1', '/tmp/agent-a')
    expect(store.get('claude', 'sess-1')).toBe('/tmp/agent-a')
    expect(store.get('qwen', 'sess-1')).toBeUndefined()
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      v: number
      entries: Record<string, { cwd: string; at: number }>
    }
    expect(raw.v).toBe(1)
    expect(raw.entries['claude:sess-1'].cwd).toBe('/tmp/agent-a')
    expect(typeof raw.entries['claude:sess-1'].at).toBe('number')
    store.close()
  })

  it('evicts the least-recently written entry at max', () => {
    const dir = tmp()
    const file = join(dir, 'session-cwd.json')
    let t = 0
    const store = createSessionCwdStore(file, { max: 2, now: () => ++t })
    store.set('claude', '1', '/tmp/a')
    store.set('claude', '2', '/tmp/b')
    store.set('claude', '3', '/tmp/c')
    expect(store.get('claude', '1')).toBeUndefined()
    expect(store.get('claude', '2')).toBe('/tmp/b')
    expect(store.get('claude', '3')).toBe('/tmp/c')
    // refreshing an entry moves it to the front of the LRU
    store.set('claude', '2', '/tmp/b2')
    store.set('claude', '4', '/tmp/d')
    expect(store.get('claude', '3')).toBeUndefined()
    expect(store.get('claude', '2')).toBe('/tmp/b2')
    expect(store.get('claude', '4')).toBe('/tmp/d')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries: Record<string, unknown> }
    expect(Object.keys(raw.entries).sort()).toEqual(['claude:2', 'claude:4'])
  })

  it('writes atomically as mode 0600 and leaves no tmp file', () => {
    const dir = tmp()
    const file = join(dir, 'nested', 'session-cwd.json')
    const store = createSessionCwdStore(file)
    store.set('claude', 'a', '/tmp/agent-a')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const names = readdirSync(join(dir, 'nested'))
    expect(names.some((name) => name.includes('.tmp-'))).toBe(false)
    expect(names).toContain('session-cwd.json')
  })

  it('quarantines a corrupt file and still accepts writes', () => {
    const dir = tmp()
    const file = join(dir, 'session-cwd.json')
    writeFileSync(file, '{ not json')
    const store = createSessionCwdStore(file)
    expect(store.get('claude', 'a')).toBeUndefined()
    expect(readdirSync(dir).some((name) => name.startsWith('session-cwd.json.corrupt-'))).toBe(true)
    store.set('claude', 'a', '/tmp/agent-a')
    expect(store.get('claude', 'a')).toBe('/tmp/agent-a')
  })

  it('quarantines a JSON file whose shape is wrong', () => {
    const dir = tmp()
    const file = join(dir, 'session-cwd.json')
    writeFileSync(file, JSON.stringify({ v: 2, entries: {} }))
    const store = createSessionCwdStore(file)
    expect(store.get('claude', 'a')).toBeUndefined()
    expect(readdirSync(dir).some((name) => name.startsWith('session-cwd.json.corrupt-'))).toBe(true)
  })

  it('re-reads when an operator edits the file', () => {
    const dir = tmp()
    const file = join(dir, 'session-cwd.json')
    const store = createSessionCwdStore(file)
    store.set('claude', 'a', '/tmp/agent-a')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      v: number
      entries: Record<string, { cwd: string; at: number }>
    }
    raw.entries['claude:a'].cwd = '/tmp/edited'
    writeFileSync(file, JSON.stringify(raw))
    const future = new Date(Date.now() + 10_000)
    utimesSync(file, future, future)
    expect(store.get('claude', 'a')).toBe('/tmp/edited')
  })
})
