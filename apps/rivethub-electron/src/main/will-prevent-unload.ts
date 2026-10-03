/**
 * Electron shows no native dialog for a cancelled beforeunload — window
 * close / tray Quit / Reload silently do nothing. Handle
 * `will-prevent-unload` with a Stay / Discard box; calling
 * `event.preventDefault()` on that event allows the unload to proceed.
 */

export const UNLOAD_STAY = 0
export const UNLOAD_DISCARD = 1

export const UNLOAD_DIALOG = {
  type: 'warning' as const,
  buttons: ['Stay', 'Discard changes'],
  defaultId: UNLOAD_STAY,
  cancelId: UNLOAD_STAY,
  title: 'Unsaved changes',
  message: 'You have unsaved changes. Discard them and leave?',
}

/** true → call preventDefault on will-prevent-unload (allow unload). */
export function shouldAllowUnload(buttonIndex: number): boolean {
  return buttonIndex === UNLOAD_DISCARD
}
