import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, normalizePreferences, usePreferences } from './preferences.js'

describe('normalizePreferences', () => {
  it('falls back to defaults for missing or malformed data', () => {
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES)
    expect(normalizePreferences({ autoScroll: 'yes', newChat: { effort: 'huge' } })).toEqual(
      DEFAULT_PREFERENCES,
    )
  })

  it('keeps well-formed fields', () => {
    expect(
      normalizePreferences({
        newChat: { agentId: 'a1', harnessId: 'claude-code', effort: 'high' },
        autoScroll: false,
        notificationSound: true,
      }),
    ).toMatchObject({
      newChat: { agentId: 'a1', harnessId: 'claude-code', effort: 'high' },
      autoScroll: false,
      desktopNotifications: true,
      notificationSound: true,
    })
  })
})

describe('setNewChat', () => {
  it('an empty value clears the field', () => {
    usePreferences.getState().setNewChat({ agentId: 'a1', effort: 'low' })
    usePreferences.getState().setNewChat({ agentId: '' })
    expect(usePreferences.getState().newChat).toEqual({ effort: 'low' })
  })
})
