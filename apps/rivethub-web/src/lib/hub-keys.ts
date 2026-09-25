/**
 * RivetHub keyboard chords, handled in the web app rather than the shell:
 *
 *   Ctrl+Tab        open the NEXT agent in the sidebar roster
 *   Ctrl+Shift+Tab  open the PREVIOUS agent
 *   Ctrl+Shift+E    toggle the left sidebar (icon rail / narrow drawer)
 *
 * Registered on `window` in the CAPTURE phase so a focused xterm never sees
 * the chord first (same technique as shell-keys.ts) — both Tab and Ctrl+Shift+E
 * would otherwise be swallowed by the terminal's custom key handler. Plain
 * Ctrl+E is deliberately NOT bound: it is end-of-line in readline/emacs, so
 * only the Shift form is claimed. `matchHubKey` is a pure matcher over the
 * fields it needs, so tests can pass plain objects instead of a DOM event.
 */

export type HubKeyAction = 'agent-next' | 'agent-prev' | 'toggle-sidebar'

/** Pure matcher; takes the fields it needs so tests can pass plain objects. */
export function matchHubKey(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
): HubKeyAction | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null
  if (e.key === 'Tab') return e.shiftKey ? 'agent-prev' : 'agent-next'
  if (e.shiftKey && e.code === 'KeyE') return 'toggle-sidebar'
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
