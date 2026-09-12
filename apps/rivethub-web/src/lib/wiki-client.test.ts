/**
 * Isolated coverage for wiki source precedence. wiki-client.ts also imports
 * connection/wiki-settings stores, which touch localStorage at module init.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  }
}

let pickWikiSource: typeof import('./wiki-client.js')['pickWikiSource']

beforeAll(async () => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('sessionStorage', memoryStorage())
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:5174' } })
  ;({ pickWikiSource } = await import('./wiki-client.js'))
})

const chat = 'https://localhost:5174'
const mesh = 'https://datahub.example.com:5174'
const settings = 'https://memory.example.com:5174'

describe('pickWikiSource', () => {
  it('prefers an explicit settings override over mesh and local', () => {
    expect(
      pickWikiSource({
        settingsBase: settings,
        chatReady: true,
        chatBase: chat,
        fromMesh: mesh,
        localOk: true,
      }),
    ).toEqual({ baseUrl: settings, source: 'settings' })
  })

  it('prefers a mesh datahub over local memory', () => {
    expect(
      pickWikiSource({
        settingsBase: '',
        chatReady: true,
        chatBase: chat,
        fromMesh: mesh,
        localOk: true,
      }),
    ).toEqual({ baseUrl: mesh, source: 'mesh' })
  })

  it('selects local when the memory probe succeeds and nothing else is set', () => {
    expect(
      pickWikiSource({
        settingsBase: '',
        chatReady: true,
        chatBase: chat,
        fromMesh: null,
        localOk: true,
      }),
    ).toEqual({ baseUrl: chat, source: 'local' })
  })

  it('returns null when the local probe has not succeeded', () => {
    expect(
      pickWikiSource({
        settingsBase: '',
        chatReady: true,
        chatBase: chat,
        fromMesh: null,
        localOk: false,
      }),
    ).toBeNull()
  })

  it('returns null when the chat node is not ready', () => {
    expect(
      pickWikiSource({
        settingsBase: '',
        chatReady: false,
        chatBase: chat,
        fromMesh: null,
        localOk: true,
      }),
    ).toBeNull()
  })
})
