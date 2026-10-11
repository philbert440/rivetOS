import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindingProblem,
  CANVAS_KEYS,
  createPressScheduler,
  cycleAgentId,
  focusInForeignDialog,
  isCurrentSeq,
  matchCanvasAction,
  matchCanvasChord,
  matchCanvasNav,
  keyLabel,
  matchHubKey,
} from './hub-keys.js'
import { combo } from './key-combo.js'
import { useKeyBindings } from '../stores/key-bindings.js'

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
    expect(matchHubKey(keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }))).toBe(
      'agent-prev',
    )
  })

  it('maps Ctrl+T to new-conversation, but not Ctrl+Shift+T', () => {
    expect(matchHubKey(keyEvent({ key: 't', code: 'KeyT', ctrlKey: true }))).toBe(
      'new-conversation',
    )
    expect(
      matchHubKey(keyEvent({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true })),
    ).toBeNull()
    expect(
      matchHubKey(keyEvent({ key: 't', code: 'KeyT', ctrlKey: true, altKey: true })),
    ).toBeNull()
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
    expect(
      matchHubKey(keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, altKey: true })),
    ).toBeNull()
  })

  it('ignores Meta+Ctrl+Tab', () => {
    expect(
      matchHubKey(keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true, metaKey: true })),
    ).toBeNull()
  })

  it('ignores Ctrl+Shift+KeyF', () => {
    expect(
      matchHubKey(keyEvent({ key: 'f', code: 'KeyF', ctrlKey: true, shiftKey: true })),
    ).toBeNull()
  })
})

describe('matchCanvasChord', () => {
  it('maps Ctrl+Space and Ctrl+0, and leaves Shift/Alt/Meta alone', () => {
    expect(matchCanvasChord(keyEvent({ code: 'Space', ctrlKey: true }))).toBe('zoom-toggle')
    expect(matchCanvasChord(keyEvent({ code: 'Digit0', ctrlKey: true }))).toBe('everything')
    expect(matchCanvasChord(keyEvent({ code: 'Space', ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(matchCanvasChord(keyEvent({ code: 'Space', ctrlKey: true, altKey: true }))).toBeNull()
    expect(matchCanvasChord(keyEvent({ code: 'Space', ctrlKey: true, metaKey: true }))).toBeNull()
    expect(matchCanvasChord(keyEvent({ code: 'Space' }))).toBeNull()
  })

  it('does not steal the existing hub chords', () => {
    expect(matchHubKey(keyEvent({ key: ' ', code: 'Space', ctrlKey: true }))).toBeNull()
    expect(matchHubKey(keyEvent({ key: '0', code: 'Digit0', ctrlKey: true }))).toBeNull()
  })
})

describe('matchCanvasNav', () => {
  it('maps arrows and jkl, Enter, and Esc', () => {
    expect(matchCanvasNav(keyEvent({ key: 'ArrowLeft' }))).toBe('left')
    expect(matchCanvasNav(keyEvent({ key: 'h' }))).toBeNull()
    expect(matchCanvasNav(keyEvent({ key: 'l' }))).toBe('right')
    expect(matchCanvasNav(keyEvent({ key: 'k' }))).toBe('up')
    expect(matchCanvasNav(keyEvent({ key: 'j' }))).toBe('down')
    expect(matchCanvasNav(keyEvent({ key: 'Enter' }))).toBe('open')
    expect(matchCanvasNav(keyEvent({ key: 'Escape' }))).toBe('out')
  })

  it('ignores modified keys', () => {
    expect(matchCanvasNav(keyEvent({ key: 'ArrowLeft', ctrlKey: true }))).toBeNull()
    expect(matchCanvasNav(keyEvent({ key: 'l', shiftKey: true }))).toBeNull()
    expect(matchCanvasNav(keyEvent({ key: 'Escape', altKey: true }))).toBeNull()
  })
})

describe('matchCanvasAction', () => {
  it('maps space, history, find, move, and remove keys', () => {
    expect(matchCanvasAction(keyEvent({ key: 'n' }))).toBe('new-space')
    expect(matchCanvasAction(keyEvent({ key: 'e' }))).toBe('rename-space')
    expect(matchCanvasAction(keyEvent({ key: 't' }))).toBe('new-thread')
    expect(matchCanvasAction(keyEvent({ key: 'h' }))).toBe('history')
    expect(matchCanvasAction(keyEvent({ key: 'm' }))).toBe('move')
    expect(matchCanvasAction(keyEvent({ key: '/' }))).toBe('find')
    expect(matchCanvasAction(keyEvent({ key: 'Delete' }))).toBe('remove-thread')
    expect(matchCanvasAction(keyEvent({ key: 'Delete', shiftKey: true }))).toBe('remove-space')
    expect(matchCanvasAction(keyEvent({ key: 'Backspace' }))).toBeNull()
    expect(matchCanvasAction(keyEvent({ key: 'Backspace', shiftKey: true }))).toBeNull()
  })

  it('maps Ctrl+J and Ctrl+` and ignores Alt, Meta, and Shift chords', () => {
    expect(matchCanvasAction(keyEvent({ key: 'j', code: 'KeyJ', ctrlKey: true }))).toBe(
      'next-waiting',
    )
    expect(matchCanvasAction(keyEvent({ key: '`', code: 'Backquote', ctrlKey: true }))).toBe('mru')
    expect(
      matchCanvasAction(keyEvent({ key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: true })),
    ).toBe(null)
    expect(matchCanvasAction(keyEvent({ key: 'h', altKey: true }))).toBeNull()
    expect(
      matchCanvasAction(keyEvent({ key: '`', code: 'Backquote', ctrlKey: true, metaKey: true })),
    ).toBe(null)
    expect(matchCanvasAction(keyEvent({ key: 'l' }))).toBeNull()
  })
})

/**
 * Browser `KeyboardEvent` fields are prototype getters. Object spread copies
 * only own properties, which is what used to drop every canvas chord and nav.
 */
class PrototypeKeyEvent {
  #key: string
  #code: string
  #ctrlKey: boolean
  #shiftKey: boolean
  #altKey: boolean
  #metaKey: boolean
  #repeat: boolean

  constructor(init: {
    key?: string
    code?: string
    ctrlKey?: boolean
    shiftKey?: boolean
    altKey?: boolean
    metaKey?: boolean
    repeat?: boolean
  }) {
    this.#key = init.key ?? ''
    this.#code = init.code ?? ''
    this.#ctrlKey = init.ctrlKey === true
    this.#shiftKey = init.shiftKey === true
    this.#altKey = init.altKey === true
    this.#metaKey = init.metaKey === true
    this.#repeat = init.repeat === true
  }

  get key(): string {
    return this.#key
  }

  get code(): string {
    return this.#code
  }

  get ctrlKey(): boolean {
    return this.#ctrlKey
  }

  get shiftKey(): boolean {
    return this.#shiftKey
  }

  get altKey(): boolean {
    return this.#altKey
  }

  get metaKey(): boolean {
    return this.#metaKey
  }

  get repeat(): boolean {
    return this.#repeat
  }
}

describe('canvas keys on a prototype-getter event', () => {
  it('matches every CANVAS_KEYS entry when spread would drop the fields', () => {
    for (const entry of CANVAS_KEYS) {
      const event = new PrototypeKeyEvent(entry.probe)
      expect(Object.hasOwn(event, 'key')).toBe(false)
      expect(Object.hasOwn(event, 'code')).toBe(false)
      expect(Object.hasOwn(event, 'ctrlKey')).toBe(false)
      const spread = { key: '', ...event }
      expect(spread.key).toBe('')
      expect(spread).not.toHaveProperty('code')
      expect(spread).not.toHaveProperty('ctrlKey')
      const chord = entry.handler === 'chord' ? matchCanvasChord(event) : null
      const nav = entry.handler === 'nav' ? matchCanvasNav(event) : null
      const action = entry.handler === 'action' ? matchCanvasAction(event) : null
      expect(chord ?? nav ?? action).toBe(entry.id)
    }
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

  it('steps past a current id that is present but ineligible', () => {
    const eligible = (id: string): boolean => id !== 'b'
    expect(cycleAgentId(ids, eligible, 'b', 1)).toBe('c')
    expect(cycleAgentId(ids, eligible, 'b', -1)).toBe('a')
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

describe('createPressScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function scheduler(delayMs: number) {
    return createPressScheduler({
      delayMs,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => {
        clearTimeout(id)
      },
    })
  }

  it('runs only the last of three presses inside the window', () => {
    const ran: string[] = []
    const scheduled = scheduler(200)
    scheduled.press(() => ran.push('a'))
    scheduled.press(() => ran.push('b'))
    scheduled.press(() => ran.push('c'))
    vi.advanceTimersByTime(199)
    expect(ran).toEqual([])
    vi.advanceTimersByTime(1)
    expect(ran).toEqual(['c'])
  })

  it('runs nothing when cancel() happens before the delay', () => {
    const ran: string[] = []
    const scheduled = scheduler(200)
    scheduled.press(() => ran.push('a'))
    scheduled.cancel()
    vi.advanceTimersByTime(500)
    expect(ran).toEqual([])
  })

  it('does not open a run whose captured sequence is stale', () => {
    let current = 0
    const opened: number[] = []
    const scheduled = scheduler(200)
    const open = (seq: number): void => {
      if (!isCurrentSeq(seq, current)) return
      opened.push(seq)
    }
    current = 1
    scheduled.press(() => open(1))
    current = 2
    vi.advanceTimersByTime(200)
    expect(opened).toEqual([])
    expect(isCurrentSeq(1, current)).toBe(false)
    scheduled.press(() => open(2))
    vi.advanceTimersByTime(200)
    expect(opened).toEqual([2])
    expect(isCurrentSeq(2, current)).toBe(true)
  })
})

describe('rebinding', () => {
  afterEach(() => {
    useKeyBindings.setState({ overrides: {}, recording: false })
  })

  it('a rebound shortcut replaces its default everywhere it is matched', () => {
    useKeyBindings.getState().setBinding('history', [combo('y')])
    expect(matchCanvasAction(keyEvent({ key: 'y' }))).toBe('history')
    expect(matchCanvasAction(keyEvent({ key: 'h' }))).toBeNull()
    expect(keyLabel('history')).toBe('Y')
    useKeyBindings
      .getState()
      .setBinding('new-conversation', [combo('n', { code: 'KeyN', alt: true })])
    expect(matchHubKey(keyEvent({ key: 'n', code: 'KeyN', altKey: true }))).toBe('new-conversation')
    expect(matchHubKey(keyEvent({ key: 't', code: 'KeyT', ctrlKey: true }))).toBeNull()
  })

  it('an emptied binding is unbound, and reset restores the default', () => {
    useKeyBindings.getState().setBinding('find', [])
    expect(matchCanvasAction(keyEvent({ key: '/' }))).toBeNull()
    expect(keyLabel('find')).toBe('')
    useKeyBindings.getState().resetBinding('find')
    expect(matchCanvasAction(keyEvent({ key: '/' }))).toBe('find')
  })

  it('matches nothing while Settings is recording a key', () => {
    useKeyBindings.getState().setRecording(true)
    expect(matchHubKey(keyEvent({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBeNull()
    expect(matchCanvasAction(keyEvent({ key: 'h' }))).toBeNull()
  })

  it('refuses a key already in use, or a bare key where typing happens', () => {
    expect(bindingProblem('new-thread', combo('h'))).toBe('H is already History.')
    expect(bindingProblem('new-conversation', combo('x'))).toMatch(/Needs Ctrl, Alt or Super/)
    expect(bindingProblem('zoom-toggle', combo('z'))).toMatch(/Needs Ctrl, Alt or Super/)
    expect(bindingProblem('new-thread', combo('y'))).toBeUndefined()
  })
})
