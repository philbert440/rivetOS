/**
 * Tests for settings-store.ts — the main-process JSON persistence that
 * survives localStorage wipes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { App } from 'electron'
import { SettingsStore } from './settings-store.js'

function mockApp(userData: string): App {
  return {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      if (name === 'appData') return path.join(os.tmpdir(), 'test-appData')
      return os.tmpdir()
    },
  } as App
}

describe('SettingsStore', () => {
  let tempDir: string
  let settingsPath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'))
    settingsPath = path.join(tempDir, 'settings.json')
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* cleanup best-effort */
    }
  })

  it('starts empty when no file exists', () => {
    const store = new SettingsStore(mockApp(tempDir))
    expect(store.getAll()).toEqual({})
  })

  it('loads existing settings.json on boot', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        'rivethub.baseUrl': 'https://example.com',
        'rivethub.theme': 'dark',
      }),
    )

    const store = new SettingsStore(mockApp(tempDir))
    expect(store.get('rivethub.baseUrl')).toBe('https://example.com')
    expect(store.get('rivethub.theme')).toBe('dark')
  })

  it('persists writes to settings.json', () => {
    const store = new SettingsStore(mockApp(tempDir))
    store.set('rivethub.roster', [{ name: 'Test', baseUrl: 'https://test.com' }])

    const raw = fs.readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed['rivethub.roster']).toEqual([{ name: 'Test', baseUrl: 'https://test.com' }])
  })

  it('setAll batch-sets multiple settings', () => {
    const store = new SettingsStore(mockApp(tempDir))
    store.setAll({
      'rivethub.baseUrl': 'https://node1.com',
      'rivethub.theme': 'light',
      'rivethub.wikiUrl': 'https://wiki.com',
    })

    expect(store.get('rivethub.baseUrl')).toBe('https://node1.com')
    expect(store.get('rivethub.theme')).toBe('light')
    expect(store.get('rivethub.wikiUrl')).toBe('https://wiki.com')
  })

  it('remove deletes a key and persists', () => {
    const store = new SettingsStore(mockApp(tempDir))
    store.set('rivethub.baseUrl', 'https://example.com')
    store.remove('rivethub.baseUrl')

    expect(store.get('rivethub.baseUrl')).toBeUndefined()
    const raw = fs.readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed).not.toHaveProperty('rivethub.baseUrl')
  })

  it('hydrates from settings.json even if migrated flag is set', () => {
    // Simulate a prior migration with a flag
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        'rivethub.baseUrl': 'https://restored.com',
        'rivethub._migrated': true,
      }),
    )

    const store = new SettingsStore(mockApp(tempDir))
    // The store loads regardless of any _migrated flag — file is source of truth
    expect(store.get('rivethub.baseUrl')).toBe('https://restored.com')
    expect(store.get('rivethub._migrated')).toBe(true)
  })

  it('survives a corrupt settings.json', () => {
    fs.writeFileSync(settingsPath, 'not valid json{')
    const store = new SettingsStore(mockApp(tempDir))
    // Starts empty, no crash
    expect(store.getAll()).toEqual({})
  })

  it('survives a non-object settings.json', () => {
    fs.writeFileSync(settingsPath, JSON.stringify(['array', 'not', 'object']))
    const store = new SettingsStore(mockApp(tempDir))
    expect(store.getAll()).toEqual({})
  })
})
