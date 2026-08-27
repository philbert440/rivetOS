import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import {
  createDialogQueue,
  type DialogQueue,
  type DialogRequest,
} from '../lib/confirm-dialog-queue.js'

/**
 * Themed Promise dialogs because `window.confirm` / `window.prompt` paint
 * native GTK message boxes in the desktop shell.
 */
export function useConfirmDialog(): {
  confirm: (message: string, opts?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>
  prompt: (
    message: string,
    opts?: { defaultValue?: string; confirmLabel?: string },
  ) => Promise<string | undefined>
  /** Keep / start-over / cancel. Cancel and backdrop resolve `undefined`. */
  choose: (
    message: string,
    opts?: { keepLabel?: string; resetLabel?: string },
  ) => Promise<'keep' | 'reset' | undefined>
  /** Render once near the page root. */
  element: JSX.Element
} {
  const [current, setCurrent] = useState<DialogRequest | undefined>()
  const [input, setInput] = useState('')
  // One dialog at a time; further calls queue (an upload loop can hit a
  // 409 per file). The queue lives in a ref so show/settle never run side
  // effects inside a setState updater (StrictMode double-invokes those); the
  // queue/settle core itself is lib/confirm-dialog-queue.ts (unit-tested).
  const queueRef = useRef<DialogQueue | null>(null)
  queueRef.current ??= createDialogQueue((req) => {
    setInput(req?.defaultValue ?? '')
    setCurrent(req)
  })
  const queue = queueRef.current

  // Navigating away mid-dialog must not hang the caller: unmount resolves the
  // current + every queued request to its cancel value (call sites treat
  // false / undefined as abort).
  useEffect(
    () => () => {
      queue.settleAll()
    },
    [queue],
  )

  const confirm = useCallback(
    (message: string, opts?: { confirmLabel?: string; danger?: boolean }): Promise<boolean> =>
      new Promise((resolve) => {
        queue.show({ kind: 'confirm', message, ...opts, resolve: (v) => resolve(v === true) })
      }),
    [queue],
  )

  const prompt = useCallback(
    (message: string, opts?: { defaultValue?: string; confirmLabel?: string }) =>
      new Promise<string | undefined>((resolve) => {
        queue.show({
          kind: 'prompt',
          message,
          ...opts,
          resolve: (v) => resolve(typeof v === 'string' ? v : undefined),
        })
      }),
    [queue],
  )

  const choose = useCallback(
    (
      message: string,
      opts?: { keepLabel?: string; resetLabel?: string },
    ): Promise<'keep' | 'reset' | undefined> =>
      new Promise((resolve) => {
        queue.show({
          kind: 'choice',
          message,
          ...opts,
          resolve: (v) => resolve(v === 'keep' || v === 'reset' ? v : undefined),
        })
      }),
    [queue],
  )

  // Cancel resolves false for confirm (matching `window.confirm`) and
  // undefined for prompt/choice (matching `window.prompt`'s null).
  const cancelValue = current?.kind === 'confirm' ? false : undefined

  const dialogRef = useRef<HTMLFormElement | null>(null)

  // Focus on open (and on each queued dialog's promotion): the prompt input,
  // else the submit/danger button — Enter confirms and Escape cancels without
  // a click into the dialog first (the common path for delete/kill/revoke).
  useEffect(() => {
    if (!current) return
    const el = dialogRef.current
    const target =
      current.kind === 'prompt'
        ? el?.querySelector('input')
        : el?.querySelector<HTMLElement>('button[type="submit"]')
    target?.focus()
  }, [current])

  // Document-level keys: the dialog claims aria-modal exclusivity, so Escape
  // cancels and Tab cycles within it even when focus never landed inside.
  useEffect(() => {
    if (!current) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        queue.settle(current.kind === 'confirm' ? false : undefined)
        return
      }
      if (e.key !== 'Tab') return
      e.preventDefault()
      const el = dialogRef.current
      const focusables = el
        ? Array.from(el.querySelectorAll<HTMLElement>('input, button')).filter(
            (n) => !n.hasAttribute('disabled'),
          )
        : []
      if (focusables.length === 0) return
      const idx = focusables.indexOf(document.activeElement as HTMLElement)
      const next =
        idx === -1
          ? focusables[e.shiftKey ? focusables.length - 1 : 0]
          : focusables[(idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length]
      next?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [current, queue])

  const element = current ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70"
      role="presentation"
      onClick={() => queue.settle(cancelValue)}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={current.message}
        tabIndex={-1}
        className="w-80 rounded-md border border-line bg-panel p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          queue.settle(
            current.kind === 'prompt' ? input : current.kind === 'choice' ? 'keep' : true,
          )
        }}
      >
        <p className="mb-3 text-sm text-ink">{current.message}</p>
        {current.kind === 'prompt' && (
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="mb-3 w-full rounded border border-line bg-bg px-2 py-1.5 text-sm text-ink outline-none focus:border-em"
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => queue.settle(cancelValue)}
            className="rounded border border-line px-3 py-1.5 text-xs text-ink-dim hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={
              current.danger
                ? 'rounded border border-red/40 px-3 py-1.5 text-xs text-red hover:border-red'
                : 'rounded bg-em-dim px-3 py-1.5 text-xs font-medium text-bg hover:bg-em'
            }
          >
            {current.kind === 'choice'
              ? (current.keepLabel ?? 'Keep')
              : (current.confirmLabel ?? 'OK')}
          </button>
          {current.kind === 'choice' && (
            <button
              type="button"
              onClick={() => queue.settle('reset')}
              className="rounded border border-red/40 px-3 py-1.5 text-xs text-red hover:border-red"
            >
              {current.resetLabel ?? 'Start over'}
            </button>
          )}
        </div>
      </form>
    </div>
  ) : (
    <></>
  )

  return { confirm, prompt, choose, element }
}
