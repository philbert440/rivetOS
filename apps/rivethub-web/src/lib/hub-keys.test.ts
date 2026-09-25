import { describe, expect, it } from 'vitest'
import { cycleAgentId, focusInForeignDialog, matchHubKey } from './hub-keys.js'

type KeyFields = Parameters<typeof matchHubKey>[0]

function keyEvent(overrides: Partial<KeyFields>): KeyFields {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  }
}

describe('matchHubKey', () => {
  it('maps Ctrl+Tab to agent-next', () => {
    expect(matchHubKey(keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBe('agent-next')
  })

  it('maps Ctrl+Shift+Tab to agent-prev', () => {
    expect(
      matchHubKey(keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true })),
    ).toBe('agent-prev')
  })

  it('maps Ctrl+Shift+KeyE to toggle-sidebar', () => {
    expect(matchHubKey(keyEvent({ key: 'e', code: 'KeyE', ctrlKey: true, shiftKey: true }))).toBe(
      'toggle-sidebar',
    )
  })

  it('leaves plain Ctrl+E alone', () => {
    expect(matchHubKey(keyEvent({ key: 'e', code: 'KeyE', ctrlKey: true }))).toBeNull()
  })

  it('ignores Tab without Ctrl', () => {
    expect(matchHubKey(keyEvent({ key: 'Tab', code: 'Tab' }))).toBeNull()
  })

  it('ignores Ctrl+Alt+Tab', () => {
    expect(matchHubKey(keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('ignores Meta+Ctrl+Tab', () => {
    expect(
      matchHubKey(keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, metaKey: true })),
    ).toBeNull()
  })

  it('ignores Ctrl+Shift+KeyF', () => {
    expect(matchHubKey(keyEvent({ key: 'f', code: 'KeyF', ctrlKey: true, shiftKey: true }))).toBeNull()
  })
})

describe('cycleAgentId', () => {
  const all = (): boolean => true
  const ids = ['a', 'b', 'c']

  it('moves forward in the middle', () => {
    expect(cycleAgentId(ids, all, 'a', 1)).toBe('b')
    expect(cycleAgentId(ids, all, 'b', 1)).toBe('c')
  })

  it('moves backward in the middle', () => {
    expect(cycleAgentId(ids, all, 'c', -1)).toBe('b')
    expect(cycleAgentId(ids, all, 'b', -1)).toBe('a')
  })

  it('wraps forward at the end and backward at the start', () => {
    expect(cycleAgentId(ids, all, 'c', 1)).toBe('a')
    expect(cycleAgentId(ids, all, 'a', -1)).toBe('c')
  })

  it('skips ineligible ids, including across the wrap', () => {
    const eligible = (id: string): boolean => id === 'a'
    expect(cycleAgentId(ids, eligible, 'a', 1)).toBe('a')
    const withGap = ['a', 'x', 'b', 'y']
    const noXy = (id: string): boolean => id !== 'x' && id !== 'y'
    expect(cycleAgentId(withGap, noXy, 'a', 1)).toBe('b')
    expect(cycleAgentId(withGap, noXy, 'b', 1)).toBe('a')
    expect(cycleAgentId(withGap, noXy, 'a', -1)).toBe('b')
  })

  it('starts at first/last eligible when current is unknown or undefined', () => {
    const eligible = (id: string): boolean => id !== 'b'
    expect(cycleAgentId(ids, eligible, undefined, 1)).toBe('a')
    expect(cycleAgentId(ids, eligible, undefined, -1)).toBe('c')
    expect(cycleAgentId(ids, eligible, 'zzz', 1)).toBe('a')
    expect(cycleAgentId(ids, eligible, 'zzz', -1)).toBe('c')
  })

  it('returns undefined when nothing is eligible', () => {
    expect(cycleAgentId(ids, () => false, 'a', 1)).toBeUndefined()
  })

  it('returns the current id when it is the only eligible one', () => {
    expect(cycleAgentId(ids, (id) => id === 'b', 'b', 1)).toBe('b')
    expect(cycleAgentId(ids, (id) => id === 'b', 'b', -1)).toBe('b')
  })

  it('returns undefined for an empty list', () => {
    expect(cycleAgentId([], all, undefined, 1)).toBeUndefined()
    expect(cycleAgentId([], all, 'a', -1)).toBeUndefined()
  })
})

describe('focusInForeignDialog', () => {
  function fakeActive(dialog: { id?: string } | null): Element | null {
    if (!dialog) return null
    return {
      closest: (selector: string) => (selector === '[role="dialog"]' ? (dialog as unknown) : null),
    } as unknown as Element
  }

  it('is false with no active element', () => {
    expect(focusInForeignDialog(null)).toBe(false)
  })

  it('is false inside the narrow rail drawer', () => {
    expect(focusInForeignDialog(fakeActive({ id: 'hub-rail' }))).toBe(false)
  })

  it('is true inside any other dialog', () => {
    expect(focusInForeignDialog(fakeActive({ id: 'agent-editor' }))).toBe(true)
    expect(focusInForeignDialog(fakeActive({}))).toBe(true)
  })
})
