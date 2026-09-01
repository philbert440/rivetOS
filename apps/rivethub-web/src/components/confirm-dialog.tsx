import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {
  createDialogQueue,
  dialogCancelValue,
  type DialogQueue,
  type DialogRequest,
} from '../lib/confirm-dialog-queue.js'

/**
 * Themed Promise dialogs because `window.confirm` / `window.prompt` paint
 * native GTK message boxes in the desktop shell.
 *
 * Rendering is Radix Dialog — focus trap/restore, Escape, outside-pointer
 * dismiss, aria-modal and scroll lock all come from the primitive (theme
 * tokens live on <html>, so the portaled content styles like the popover).
 * The Promise contract and one-at-a-time queue stay framework-free in
 * lib/confirm-dialog-queue.ts (unit-tested).
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
  // Bumped per displayed request and used as the Content key, so a promoted
  // queued dialog remounts and Radix re-runs its open auto-focus (the focus
  // scope only auto-focuses on mount, not on a content swap while open).
  const [seq, setSeq] = useState(0)
  // One dialog at a time; further calls queue (an upload loop can hit a
  // 409 per file). The queue lives in a ref so show/settle never run side
  // effects inside a setState updater (StrictMode double-invokes those); the
  // queue/settle core itself is lib/confirm-dialog-queue.ts (unit-tested).
  const queueRef = useRef<DialogQueue | null>(null)
  queueRef.current ??= createDialogQueue((req) => {
    setInput(req?.defaultValue ?? '')
    setCurrent(req)
    setSeq((n) => n + 1)
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
  const cancelValue = current ? dialogCancelValue(current) : undefined

  const formRef = useRef<HTMLFormElement | null>(null)

  const element = (
    <Dialog.Root
      open={current !== undefined}
      onOpenChange={(open) => {
        // Escape and pointer-down-outside both route here (Radix owns the
        // gestures); settling resolves the caller's Promise with its cancel
        // value. No-op when the last dialog already settled programmatically.
        if (!open) queue.settle(cancelValue)
      }}
    >
      {current && (
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-bg/70" />
          <Dialog.Content
            key={seq}
            className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-md border border-line bg-panel p-4 shadow-lg outline-none"
            onOpenAutoFocus={(e) => {
              // Preserve the old keyboard flow: prompt focuses the input,
              // confirm/choice focus the submit/danger button — Enter confirms
              // and Escape cancels without a click into the dialog first (the
              // common path for delete/kill/revoke).
              e.preventDefault()
              const el = formRef.current
              const target =
                current.kind === 'prompt'
                  ? el?.querySelector('input')
                  : el?.querySelector<HTMLElement>('button[type="submit"]')
              target?.focus()
            }}
          >
            {/* The visible message is the dialog's accessible name (Title
                asChild); the kind word is a redundant sr-only Description. */}
            <Dialog.Description className="sr-only">
              {current.kind === 'prompt'
                ? 'Prompt'
                : current.kind === 'choice'
                  ? 'Choose'
                  : 'Confirm'}
            </Dialog.Description>
            <form
              ref={formRef}
              onSubmit={(e) => {
                e.preventDefault()
                queue.settle(
                  current.kind === 'prompt' ? input : current.kind === 'choice' ? 'keep' : true,
                )
              }}
            >
              <Dialog.Title asChild>
                <p className="mb-3 text-sm text-ink">{current.message}</p>
              </Dialog.Title>
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
          </Dialog.Content>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  )

  return { confirm, prompt, choose, element }
}
