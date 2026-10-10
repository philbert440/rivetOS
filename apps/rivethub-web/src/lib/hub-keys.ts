/**
 * RivetHub keyboard chords, handled in the web app rather than the shell.
 * Defaults below; every one can be rebound in Settings (stores/key-bindings).
 *
 *   Ctrl+Tab        open the NEXT agent in the sidebar roster
 *   Ctrl+Shift+Tab  open the PREVIOUS agent
 *   Ctrl+Shift+E    collapse / expand every side pane (rail AND
 *                   conversations); the narrow drawer on the phone
 *   Ctrl+T          start a new conversation (with the selected agent)
 *
 * Registered on `window` in the CAPTURE phase so a focused xterm never sees
 * the chord first (same technique as shell-keys.ts) — Tab, Ctrl+Shift+E and
 * Ctrl+T would otherwise be swallowed by the terminal's custom key handler.
 * Plain Ctrl+E is deliberately NOT bound: it is end-of-line in readline/emacs,
 * so only the Shift form is claimed. Ctrl+T IS claimed, trading readline's
 * transpose-chars for a new conversation (asked for explicitly); browsers
 * keep Ctrl+T for a new tab, so like Ctrl+Tab it is a desktop-shell chord. `matchHubKey` is a pure matcher over the
 * fields it needs, so tests can pass plain objects instead of a DOM event.
 */

import {
  combo,
  formatCombo,
  hasCommandModifier,
  matchCombo,
  sameCombo,
  type KeyCombo,
} from './key-combo.js'
import { useKeyBindings } from '../stores/key-bindings.js'

export type HubKeyAction = 'agent-next' | 'agent-prev' | 'toggle-sidebar' | 'new-conversation'

/** Canvas chords. Kept off `matchHubKey` so the sidebar listener does not claim them. */
export type CanvasChord = 'zoom-toggle' | 'everything'

export type CanvasNav = 'left' | 'right' | 'up' | 'down' | 'open' | 'out'

/** Canvas commands that are not camera navigation. Single-letter keys,
 *  Ctrl+J, and Ctrl+` are not claimed at Thread altitude. `?` opens the
 *  Keys panel at Space and Everything; the dock button does it at Thread. */
export type CanvasAction =
  | 'new-space'
  | 'rename-space'
  | 'new-thread'
  | 'remove-thread'
  | 'remove-space'
  | 'find'
  | 'move'
  | 'history'
  | 'next-waiting'
  | 'mru'
  | 'keys'

type CanvasKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'
> & { repeat?: boolean }

/** One row the matchers, the Thread claim, the Keys panel and Settings read.
 *  The keys themselves are the current binding (`keysFor`), not the row. */
export interface CanvasKeyEntry {
  id: string
  /** Short name for Settings. */
  name: string
  summary: string
  /** Spelled out at Thread, including when the key is not claimed. */
  thread: string
  claimedAtThread: boolean
  handler: 'chord' | 'nav' | 'action'
  defaults: readonly KeyCombo[]
  /** Event the default binding must accept. The coverage test fires this. */
  probe: CanvasKeyEvent
}

function bare(key: string, code = ''): CanvasKeyEvent {
  return { key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
}

function defineKey<H extends 'chord' | 'nav' | 'action'>(
  handler: H,
  row: {
    id: H extends 'chord' ? CanvasChord : H extends 'nav' ? CanvasNav : CanvasAction
    name: string
    summary: string
    thread: string
    claimedAtThread: boolean
    defaults: readonly KeyCombo[]
    probe: CanvasKeyEvent
  },
): CanvasKeyEntry {
  return { handler, ...row }
}

/**
 * `h` is History, not left. `?` allows Shift (`?` is Shift+/ on a US keyboard)
 * and does not require it, so the matcher keys off `e.key`.
 */
export const CANVAS_KEYS: readonly CanvasKeyEntry[] = [
  defineKey('chord', {
    id: 'zoom-toggle',
    name: 'Zoom toggle',
    summary: 'Toggle Thread and Space. From Everything, open the selection.',
    thread: 'Zooms out to the space.',
    claimedAtThread: true,
    defaults: [combo(' ', { code: 'Space', ctrl: true })],
    probe: { ...bare('', 'Space'), ctrlKey: true },
  }),
  defineKey('chord', {
    id: 'everything',
    name: 'Frame everything',
    summary: 'Frame every space.',
    thread: 'Leaves the thread and frames every space.',
    claimedAtThread: true,
    defaults: [combo('0', { code: 'Digit0', ctrl: true })],
    probe: { ...bare('', 'Digit0'), ctrlKey: true },
  }),
  defineKey('nav', {
    id: 'left',
    name: 'Select left',
    summary: 'Move the selection left. h is History, not left.',
    thread: 'Not claimed. The session keeps the arrow.',
    claimedAtThread: false,
    defaults: [combo('ArrowLeft')],
    probe: bare('ArrowLeft'),
  }),
  defineKey('nav', {
    id: 'right',
    name: 'Select right',
    summary: 'Move the selection right.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    defaults: [combo('ArrowRight'), combo('l')],
    probe: bare('l'),
  }),
  defineKey('nav', {
    id: 'up',
    name: 'Select up',
    summary: 'Move the selection up.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    defaults: [combo('ArrowUp'), combo('k')],
    probe: bare('k'),
  }),
  defineKey('nav', {
    id: 'down',
    name: 'Select down',
    summary: 'Move the selection down.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    defaults: [combo('ArrowDown'), combo('j')],
    probe: bare('j'),
  }),
  defineKey('nav', {
    id: 'open',
    name: 'Open selection',
    summary: 'Open the selection at Thread.',
    thread: 'Not claimed. Enter stays in the composer.',
    claimedAtThread: false,
    defaults: [combo('Enter')],
    probe: bare('Enter'),
  }),
  defineKey('nav', {
    id: 'out',
    name: 'Back out',
    summary: 'From Space, back to Everything. From Everything, nothing.',
    thread: 'Not claimed. Esc stays with the session.',
    claimedAtThread: false,
    defaults: [combo('Escape')],
    probe: bare('Escape'),
  }),
  defineKey('action', {
    id: 'new-space',
    name: 'New space',
    summary: 'New space. Name only — defaults are edited after.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    defaults: [combo('n')],
    probe: bare('n'),
  }),
  defineKey('action', {
    id: 'rename-space',
    name: 'Edit space',
    summary: 'Edit the space you are in (name and defaults).',
    thread: 'Not claimed. The region Edit button is hidden at Thread.',
    claimedAtThread: false,
    defaults: [combo('e')],
    probe: bare('e'),
  }),
  defineKey('action', {
    id: 'new-thread',
    name: 'New thread',
    summary: 'New thread in the space you are in.',
    thread: 'Not claimed. The dock + Thread button still opens the chooser.',
    claimedAtThread: false,
    defaults: [combo('t')],
    probe: bare('t'),
  }),
  defineKey('action', {
    id: 'move',
    name: 'Move thread',
    summary:
      'Move the selected thread to another space, or back to History. Keyboard alternative to dragging.',
    thread: 'Not claimed. The dock Move button still opens Move to….',
    claimedAtThread: false,
    defaults: [combo('m')],
    probe: bare('m'),
  }),
  defineKey('action', {
    id: 'history',
    name: 'History',
    summary: 'Show or hide History.',
    thread: 'Not claimed. The dock History button still toggles it.',
    claimedAtThread: false,
    defaults: [combo('h')],
    probe: bare('h'),
  }),
  defineKey('action', {
    id: 'find',
    name: 'Find',
    summary: 'Find an agent, thread, or space. Enter opens the top hit.',
    thread: 'Not claimed. Find closes when a thread opens.',
    claimedAtThread: false,
    defaults: [combo('/')],
    probe: bare('/'),
  }),
  defineKey('action', {
    id: 'remove-thread',
    name: 'Archive thread',
    summary: 'Archive the selected thread. An unpinned draft is discarded. Backspace does nothing.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    defaults: [combo('Delete')],
    probe: bare('Delete'),
  }),
  defineKey('action', {
    id: 'remove-space',
    name: 'Remove space',
    summary: 'Remove the space you are in. Its threads move to History; sessions are not deleted.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    defaults: [combo('Delete', { shift: true })],
    probe: { ...bare('Delete'), shiftKey: true },
  }),
  defineKey('action', {
    id: 'next-waiting',
    name: 'Next waiting',
    summary: 'Open the next thread that is waiting on you.',
    thread: 'Not claimed. The Needs you dock button and the toast still jump.',
    claimedAtThread: false,
    defaults: [combo('j', { code: 'KeyJ', ctrl: true })],
    probe: { ...bare('j', 'KeyJ'), ctrlKey: true },
  }),
  defineKey('action', {
    id: 'mru',
    name: 'Recent threads',
    summary: 'Step recent threads. Releasing Ctrl opens the preview.',
    thread: 'Not claimed. The dock Recent button opens the previous thread.',
    claimedAtThread: false,
    defaults: [combo('`', { code: 'Backquote', ctrl: true })],
    probe: { ...bare('`', 'Backquote'), ctrlKey: true },
  }),
  defineKey('action', {
    id: 'keys',
    name: 'Keys list',
    summary: 'Show or hide this list.',
    thread: 'Not claimed. The dock ? button still opens it.',
    claimedAtThread: false,
    defaults: [combo('?')],
    probe: { ...bare('?', 'Slash'), shiftKey: true },
  }),
]

/** App-wide chords. Handled on every page, so each needs Ctrl, Alt or Super. */
export interface HubKeyEntry {
  id: HubKeyAction
  name: string
  summary: string
  defaults: readonly KeyCombo[]
}

export const HUB_KEYS: readonly HubKeyEntry[] = [
  {
    id: 'agent-next',
    name: 'Next agent',
    summary: 'Open the next agent in the sidebar roster.',
    defaults: [combo('Tab', { code: 'Tab', ctrl: true })],
  },
  {
    id: 'agent-prev',
    name: 'Previous agent',
    summary: 'Open the previous agent in the sidebar roster.',
    defaults: [combo('Tab', { code: 'Tab', ctrl: true, shift: true })],
  },
  {
    id: 'toggle-sidebar',
    name: 'Toggle side panes',
    summary: 'Collapse or expand every side pane.',
    defaults: [combo('e', { code: 'KeyE', ctrl: true, shift: true })],
  },
  {
    id: 'new-conversation',
    name: 'New conversation',
    summary: 'Start a new conversation (with the selected agent).',
    defaults: [combo('t', { code: 'KeyT', ctrl: true })],
  },
]

/** Current binding for an action id: the user's override, else the default. */
export function keysFor(id: string): readonly KeyCombo[] {
  const { overrides } = useKeyBindings.getState()
  if (Object.hasOwn(overrides, id)) return overrides[id]
  return (
    CANVAS_KEYS.find((entry) => entry.id === id)?.defaults ??
    HUB_KEYS.find((entry) => entry.id === id)?.defaults ??
    []
  )
}

/** `H`, `→ or L`, `Ctrl+Space`; empty when unbound. */
export function keyLabel(id: string): string {
  return keysFor(id).map(formatCombo).join(' or ')
}

/** Where a combo may not go: a key active while typing must carry a command
 *  modifier, and one key cannot drive two actions. */
export function bindingProblem(id: string, next: KeyCombo): string | undefined {
  const typingSafe =
    HUB_KEYS.some((e) => e.id === id) || CANVAS_KEYS.some((e) => e.id === id && e.claimedAtThread)
  if (typingSafe && !hasCommandModifier(next)) {
    return 'Needs Ctrl, Alt or Super — this one works while you type.'
  }
  for (const entry of [...HUB_KEYS, ...CANVAS_KEYS]) {
    if (entry.id === id) continue
    if (keysFor(entry.id).some((c) => sameCombo(c, next))) {
      return `${formatCombo(next)} is already ${entry.name}.`
    }
  }
  return undefined
}

function matches(id: string, e: CanvasKeyEvent): boolean {
  return keysFor(id).some((c) => matchCombo(c, e))
}

function matchFrom(handler: CanvasKeyEntry['handler'], e: CanvasKeyEvent): string | null {
  if (useKeyBindings.getState().recording) return null
  for (const entry of CANVAS_KEYS) {
    if (entry.handler !== handler) continue
    if (matches(entry.id, e)) return entry.id
  }
  return null
}

type CanvasKeySource = {
  key?: string
  code?: string
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  repeat?: boolean
}

/**
 * Read the fields. A browser `KeyboardEvent` keeps them on the prototype, and
 * an object spread only copies own properties, so `{ key: '', ...event }`
 * arrives with `key` forced empty and `ctrlKey` / `code` missing.
 */
function readCanvasKey(e: CanvasKeySource): CanvasKeyEvent {
  return {
    key: e.key ?? '',
    code: e.code ?? '',
    ctrlKey: e.ctrlKey === true,
    shiftKey: e.shiftKey === true,
    altKey: e.altKey === true,
    metaKey: e.metaKey === true,
    repeat: e.repeat === true,
  }
}

/** Ctrl+Space toggles thread/space. Ctrl+0 frames everything. */
export function matchCanvasChord(e: CanvasKeySource): CanvasChord | null {
  return matchFrom('chord', readCanvasKey(e)) as CanvasChord | null
}

/**
 * Selection keys at space / everything altitude. Not a Ctrl chord. Esc is
 * "out" here; the canvas listener must not claim it at thread altitude.
 * `h` is History, so left is ArrowLeft only.
 */
export function matchCanvasNav(e: CanvasKeySource): CanvasNav | null {
  return matchFrom('nav', readCanvasKey(e)) as CanvasNav | null
}

export function matchCanvasAction(e: CanvasKeySource): CanvasAction | null {
  return matchFrom('action', readCanvasKey(e)) as CanvasAction | null
}

/** Pure matcher; takes the fields it needs so tests can pass plain objects. */
export function matchHubKey(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
): HubKeyAction | null {
  if (useKeyBindings.getState().recording) return null
  const fields = readCanvasKey(e)
  for (const entry of HUB_KEYS) {
    if (matches(entry.id, fields)) return entry.id
  }
  return null
}

/** Next/prev eligible id with wrap. `currentId` undefined or not in list →
 *  first (dir 1) / last (dir -1). Returns undefined when no id is eligible.
 *  Never returns `currentId` unless it is the only eligible one. */
export function cycleAgentId(
  ids: readonly string[],
  eligible: (id: string) => boolean,
  currentId: string | undefined,
  dir: 1 | -1,
): string | undefined {
  if (ids.length === 0) return undefined
  const eligibleIds = ids.filter(eligible)
  if (eligibleIds.length === 0) return undefined
  if (currentId === undefined || !ids.includes(currentId)) {
    return dir === 1 ? eligibleIds[0] : eligibleIds[eligibleIds.length - 1]
  }
  const start = ids.indexOf(currentId)
  for (let step = 1; step <= ids.length; step++) {
    const index = (((start + dir * step) % ids.length) + ids.length) % ids.length
    const candidate = ids[index]
    if (eligible(candidate)) return candidate
  }
  return undefined
}

/** True when focus sits inside a modal dialog other than the narrow rail
 *  drawer (which is itself `role="dialog"` with `id="hub-rail"`). Protects the
 *  agent editor's Tab focus trap and Radix dialogs. */
export function focusInForeignDialog(active: Element | null): boolean {
  if (!active) return false
  const dialog = active.closest('[role="dialog"]')
  if (!dialog) return false
  return dialog.id !== 'hub-rail'
}

/** How long a Ctrl+Tab burst waits before the last target opens. Long enough
 *  to collapse a fast chord; a settled burst still feels instant. */
export const HUB_CYCLE_OPEN_DELAY_MS = 250

export interface PressScheduler {
  /** Clear any pending run and arm `run` after the configured delay. */
  press(run: () => void): void
  /** Drop a pending run without invoking it. */
  cancel(): void
}

/** Timer bookkeeping for a burst of keypresses. Each `press` clears the
 *  previous timer and arms a new one; `cancel` clears. Timers are injected so
 *  tests can drive them without a DOM. */
export function createPressScheduler(opts: {
  delayMs: number
  setTimeout: (fn: () => void, ms: number) => number
  clearTimeout: (id: number) => void
}): PressScheduler {
  let timer: number | undefined
  return {
    press(run) {
      if (timer !== undefined) {
        opts.clearTimeout(timer)
        timer = undefined
      }
      timer = opts.setTimeout(() => {
        timer = undefined
        run()
      }, opts.delayMs)
    },
    cancel() {
      if (timer !== undefined) {
        opts.clearTimeout(timer)
        timer = undefined
      }
    },
  }
}

/** True when a captured open sequence is still the latest selection. */
export function isCurrentSeq(seq: number, current: number): boolean {
  return seq === current
}
