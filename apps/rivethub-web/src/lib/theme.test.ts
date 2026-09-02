import { describe, expect, it } from 'vitest'
import {
  loadThemePreference,
  parseThemePreference,
  resolveTheme,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from './theme.js'

describe('parseThemePreference', () => {
  it('accepts the four stored values', () => {
    expect(parseThemePreference('light')).toBe('light')
    expect(parseThemePreference('dark')).toBe('dark')
    expect(parseThemePreference('system')).toBe('system')
    expect(parseThemePreference('omarchy')).toBe('omarchy')
  })

  it('defaults to system when unset or garbage', () => {
    expect(parseThemePreference(null)).toBe('system')
    expect(parseThemePreference(undefined)).toBe('system')
    expect(parseThemePreference('')).toBe('system')
    expect(parseThemePreference('blue')).toBe('system')
    expect(parseThemePreference('LIGHT')).toBe('system')
  })
})

describe('loadThemePreference / saveThemePreference', () => {
  it('round-trips through the rivethub.theme key', () => {
    const store = new Map<string, string>()
    const get = (key: string): string | null => store.get(key) ?? null
    const set = (key: string, value: string): void => {
      store.set(key, value)
    }
    expect(loadThemePreference(get)).toBe('system')
    saveThemePreference('light', set)
    expect(store.get(THEME_STORAGE_KEY)).toBe('light')
    expect(loadThemePreference(get)).toBe('light')
    saveThemePreference('dark', set)
    expect(loadThemePreference(get)).toBe('dark')
    saveThemePreference('omarchy', set)
    expect(loadThemePreference(get)).toBe('omarchy')
  })

  it('uses the bare key rivethub.theme', () => {
    expect(THEME_STORAGE_KEY).toBe('rivethub.theme')
  })

  it('treats a corrupt stored value as system', () => {
    expect(loadThemePreference(() => '{"state":{"theme":"dark"}}')).toBe('system')
  })
})

describe('resolveTheme', () => {
  it('explicit preference wins regardless of the OS setting', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('system follows the OS setting', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('omarchy uses the snapshot mode, falling back to the OS setting', () => {
    expect(resolveTheme('omarchy', true, 'light')).toBe('light')
    expect(resolveTheme('omarchy', false, 'dark')).toBe('dark')
    expect(resolveTheme('omarchy', true)).toBe('dark')
    expect(resolveTheme('omarchy', false)).toBe('light')
  })
})
