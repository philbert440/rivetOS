/**
 * RivetHub keyboard chords, handled in the web app rather than the shell:
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

/** One row the matchers, the Thread claim, and the Keys panel all read. */
export interface CanvasKeyEntry {
  id: string
  keys: string
  summary: string
  /** Spelled out at Thread, including when the key is not claimed. */
  thread: string
  claimedAtThread: boolean
  handler: 'chord' | 'nav' | 'action'
  matches: (e: CanvasKeyEvent) => boolean
  /** Event the matcher must accept. The coverage test fires this. */
  probe: CanvasKeyEvent
}

function bare(key: string, code = ''): CanvasKeyEvent {
  return { key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
}

function noMod(e: CanvasKeyEvent): boolean {
  return !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
}

function ctrlOnly(e: CanvasKeyEvent): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
}

function letter(e: CanvasKeyEvent, lower: string): boolean {
  return noMod(e) && (e.key === lower || e.key === lower.toUpperCase())
}

function defineKey<H extends 'chord' | 'nav' | 'action'>(
  handler: H,
  row: {
    id: H extends 'chord' ? CanvasChord : H extends 'nav' ? CanvasNav : CanvasAction
    keys: string
    summary: string
    thread: string
    claimedAtThread: boolean
    matches: (e: CanvasKeyEvent) => boolean
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
    keys: 'Ctrl+Space',
    summary: 'Toggle Thread and Space. From Everything, open the selection.',
    thread: 'Zooms out to the space.',
    claimedAtThread: true,
    matches: (e) => ctrlOnly(e) && e.code === 'Space',
    probe: { ...bare('', 'Space'), ctrlKey: true },
  }),
  defineKey('chord', {
    id: 'everything',
    keys: 'Ctrl+0',
    summary: 'Frame every space.',
    thread: 'Leaves the thread and frames every space.',
    claimedAtThread: true,
    matches: (e) => ctrlOnly(e) && e.code === 'Digit0',
    probe: { ...bare('', 'Digit0'), ctrlKey: true },
  }),
  defineKey('nav', {
    id: 'left',
    keys: '←',
    summary: 'Move the selection left. h is History, not left.',
    thread: 'Not claimed. The session keeps the arrow.',
    claimedAtThread: false,
    matches: (e) => noMod(e) && e.key === 'ArrowLeft',
    probe: bare('ArrowLeft'),
  }),
  defineKey('nav', {
    id: 'right',
    keys: '→ or l',
    summary: 'Move the selection right.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    matches: (e) => noMod(e) && (e.key === 'ArrowRight' || e.key === 'l'),
    probe: bare('l'),
  }),
  defineKey('nav', {
    id: 'up',
    keys: '↑ or k',
    summary: 'Move the selection up.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    matches: (e) => noMod(e) && (e.key === 'ArrowUp' || e.key === 'k'),
    probe: bare('k'),
  }),
  defineKey('nav', {
    id: 'down',
    keys: '↓ or j',
    summary: 'Move the selection down.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    matches: (e) => noMod(e) && (e.key === 'ArrowDown' || e.key === 'j'),
    probe: bare('j'),
  }),
  defineKey('nav', {
    id: 'open',
    keys: 'Enter',
    summary: 'Open the selection at Thread.',
    thread: 'Not claimed. Enter stays in the composer.',
    claimedAtThread: false,
    matches: (e) => noMod(e) && e.key === 'Enter',
    probe: bare('Enter'),
  }),
  defineKey('nav', {
    id: 'out',
    keys: 'Esc',
    summary: 'From Space, back to Everything. From Everything, nothing.',
    thread: 'Not claimed. Esc stays with the session.',
    claimedAtThread: false,
    matches: (e) => noMod(e) && e.key === 'Escape',
    probe: bare('Escape'),
  }),
  defineKey('action', {
    id: 'new-space',
    keys: 'N',
    summary: 'New space. Name only — defaults are edited after.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    matches: (e) => letter(e, 'n'),
    probe: bare('n'),
  }),
  defineKey('action', {
    id: 'rename-space',
    keys: 'E',
    summary: 'Edit the space you are in (name and defaults).',
    thread: 'Not claimed. The region Edit button is hidden at Thread.',
    claimedAtThread: false,
    matches: (e) => letter(e, 'e'),
    probe: bare('e'),
  }),
  defineKey('action', {
    id: 'new-thread',
    keys: 'T',
    summary: 'New thread in the space you are in.',
    thread: 'Not claimed. The dock + Thread button still opens the chooser.',
    claimedAtThread: false,
    matches: (e) => letter(e, 't'),
    probe: bare('t'),
  }),
  defineKey('action', {
    id: 'move',
    keys: 'M',
    summary:
      'Move the selected thread to another space, or back to History. Keyboard alternative to dragging.',
    thread: 'Not claimed. The dock Move button still opens Move to….',
    claimedAtThread: false,
    matches: (e) => letter(e, 'm'),
    probe: bare('m'),
  }),
  defineKey('action', {
    id: 'history',
    keys: 'H',
    summary: 'Show or hide History.',
    thread: 'Not claimed. The dock History button still toggles it.',
    claimedAtThread: false,
    matches: (e) => letter(e, 'h'),
    probe: bare('h'),
  }),
  defineKey('action', {
    id: 'find',
    keys: '/',
    summary: 'Find an agent, thread, or space. Enter opens the top hit.',
    thread: 'Not claimed. Find closes when a thread opens.',
    claimedAtThread: false,
    matches: (e) => noMod(e) && e.key === '/',
    probe: bare('/'),
  }),
  defineKey('action', {
    id: 'remove-thread',
    keys: 'Delete',
    summary: 'Archive the selected thread. An unpinned draft is discarded. Backspace does nothing.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    matches: (e) => noMod(e) && e.key === 'Delete',
    probe: bare('Delete'),
  }),
  defineKey('action', {
    id: 'remove-space',
    keys: 'Shift+Delete',
    summary: 'Remove the space you are in. Its threads move to History; sessions are not deleted.',
    thread: 'Not claimed.',
    claimedAtThread: false,
    matches: (e) => e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Delete',
    probe: { ...bare('Delete'), shiftKey: true },
  }),
  defineKey('action', {
    id: 'next-waiting',
    keys: 'Ctrl+J',
    summary: 'Open the next thread that is waiting on you.',
    thread: 'Not claimed. The Needs you dock button and the toast still jump.',
    claimedAtThread: false,
    matches: (e) => ctrlOnly(e) && e.code === 'KeyJ',
    probe: { ...bare('j', 'KeyJ'), ctrlKey: true },
  }),
  defineKey('action', {
    id: 'mru',
    keys: 'Ctrl+`',
    summary: 'Step recent threads. Releasing Ctrl opens the preview.',
    thread: 'Not claimed. The dock Recent button steps threads while one is open.',
    claimedAtThread: false,
    matches: (e) => ctrlOnly(e) && e.code === 'Backquote',
    probe: { ...bare('`', 'Backquote'), ctrlKey: true },
  }),
  defineKey('action', {
    id: 'keys',
    keys: '?',
    summary: 'Show or hide this list.',
    thread: 'Not claimed. The dock ? button still opens it.',
    claimedAtThread: false,
    matches: (e) => !e.ctrlKey && !e.altKey && !e.metaKey && e.key === '?',
    probe: { ...bare('?', 'Slash'), shiftKey: true },
  }),
]

function matchFrom(handler: CanvasKeyEntry['handler'], e: CanvasKeyEvent): string | null {
  for (const entry of CANVAS_KEYS) {
    if (entry.handler !== handler) continue
    if (entry.matches(e)) return entry.id
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
  if (!e.ctrlKey || e.altKey || e.metaKey) return null
  if (e.key === 'Tab') return e.shiftKey ? 'agent-prev' : 'agent-next'
  if (e.shiftKey && e.code === 'KeyE') return 'toggle-sidebar'
  if (!e.shiftKey && e.code === 'KeyT') return 'new-conversation'
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
