import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS, settingsTab } from './settings-tabs.js'

describe('settingsTab', () => {
  it('opens General for bare /settings and unknown ids', () => {
    expect(settingsTab(undefined)).toBe('general')
    expect(settingsTab('nope')).toBe('general')
  })

  it('opens each known tab by id', () => {
    for (const tab of SETTINGS_TABS) expect(settingsTab(tab.id)).toBe(tab.id)
  })
})
