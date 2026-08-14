/**
 * Queue/settle core for the themed confirm/prompt dialogs
 * (components/confirm-dialog.tsx). Framework-free on purpose — the React hook
 * is a thin wrapper, so the Promise contract is unit-testable without a DOM
 * (same pattern as outbound-pump.ts).
 *
 * One dialog at a time; further requests queue (an upload loop can hit a 409
 * per file). Every request's Promise resolves exactly once: user action via
 * `settle`, or unmount via `settleAll` — navigating away mid-dialog must not
 * leave `await confirm(...)` pending forever (call sites treat the cancel
 * value as abort).
 */

export interface DialogRequest {
  kind: 'confirm' | 'prompt'
  message: string
  defaultValue?: string
  confirmLabel?: string
  /** Red confirm button for destructive actions (delete, kill, revoke). */
  danger?: boolean
  resolve: (value: string | boolean | undefined) => void
}

/** Cancel resolves false for confirm (matching `window.confirm`) and
 *  undefined for prompt (matching `window.prompt`'s null). */
export function dialogCancelValue(req: DialogRequest): string | boolean | undefined {
  return req.kind === 'confirm' ? false : undefined
}

export interface DialogQueue {
  /** Enqueue a request; it becomes current when nothing else is showing. */
  show(req: DialogRequest): void
  /** Resolve the current request and promote the next queued one. */
  settle(value: string | boolean | undefined): void
  /**
   * Unmount: resolve the current AND every queued request to its cancel
   * value. The dialogs are not modal and do not block navigation, so without
   * this every pending `await confirm(...)` — and its caller's busy state —
   * would hang forever.
   */
  settleAll(): void
  /** The request currently displayed (undefined when idle). */
  current(): DialogRequest | undefined
}

/** `onCurrent` fires (synchronously) whenever the displayed request changes,
 *  including to undefined when the last one settles. */
export function createDialogQueue(
  onCurrent: (req: DialogRequest | undefined) => void,
): DialogQueue {
  let current: DialogRequest | undefined
  const pending: DialogRequest[] = []

  const promote = (): void => {
    current = pending.shift()
    onCurrent(current)
  }

  return {
    show: (req) => {
      pending.push(req)
      if (current) return
      promote()
    },
    settle: (value) => {
      if (!current) return
      current.resolve(value)
      promote()
    },
    settleAll: () => {
      current?.resolve(dialogCancelValue(current))
      for (const req of pending) req.resolve(dialogCancelValue(req))
      pending.length = 0
      if (current) {
        current = undefined
        onCurrent(undefined)
      }
    },
    current: () => current,
  }
}
