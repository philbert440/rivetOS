import { useCallback, useRef, useState, type JSX } from 'react'

interface DialogRequest {
  kind: 'confirm' | 'prompt'
  message: string
  defaultValue?: string
  confirmLabel?: string
  /** Red confirm button for destructive actions (delete, kill, revoke). */
  danger?: boolean
  resolve: (value: string | boolean | undefined) => void
}

/**
 * Themed confirm/prompt dialogs on Rivet tokens.
 *
 * **Not** `window.confirm` / `window.prompt`: WebKitGTK (desktop shell)
 * paints native GTK message boxes that ignore our CSS and look like OS
 * chrome — the same argument select.tsx makes for dropdowns. Promise-based,
 * so call sites keep their sequential `if (await confirm(...))` shape.
 */
export function useConfirmDialog(): {
  confirm: (message: string, opts?: { confirmLabel?: string; danger?: boolean }) => Promise<boolean>
  prompt: (
    message: string,
    opts?: { defaultValue?: string; confirmLabel?: string },
  ) => Promise<string | undefined>
  /** Render once near the page root. */
  element: JSX.Element
} {
  const [current, setCurrent] = useState<DialogRequest | undefined>()
  const [input, setInput] = useState('')
  // One dialog at a time; further calls queue (an upload loop can hit a
  // 409 per file). currentRef mirrors state so show/settle never run side
  // effects inside a setState updater (StrictMode double-invokes those).
  const queue = useRef<DialogRequest[]>([])
  const currentRef = useRef<DialogRequest | undefined>(undefined)

  const show = useCallback((req: DialogRequest): void => {
    queue.current.push(req)
    if (currentRef.current) return
    const next = queue.current.shift()
    currentRef.current = next
    setInput(next?.defaultValue ?? '')
    setCurrent(next)
  }, [])

  const settle = useCallback((value: string | boolean | undefined): void => {
    const cur = currentRef.current
    if (!cur) return
    cur.resolve(value)
    const next = queue.current.shift()
    currentRef.current = next
    setInput(next?.defaultValue ?? '')
    setCurrent(next)
  }, [])

  const confirm = useCallback(
    (message: string, opts?: { confirmLabel?: string; danger?: boolean }): Promise<boolean> =>
      new Promise((resolve) => {
        show({ kind: 'confirm', message, ...opts, resolve: (v) => resolve(v === true) })
      }),
    [show],
  )

  const prompt = useCallback(
    (message: string, opts?: { defaultValue?: string; confirmLabel?: string }) =>
      new Promise<string | undefined>((resolve) => {
        show({
          kind: 'prompt',
          message,
          ...opts,
          resolve: (v) => resolve(typeof v === 'string' ? v : undefined),
        })
      }),
    [show],
  )

  // Cancel resolves false for confirm (matching `window.confirm`) and
  // undefined for prompt (matching `window.prompt`'s null).
  const cancelValue = current?.kind === 'confirm' ? false : undefined

  const element = current ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70"
      role="presentation"
      onClick={() => settle(cancelValue)}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={current.message}
        className="w-80 rounded-md border border-line bg-panel p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') settle(cancelValue)
        }}
        onSubmit={(e) => {
          e.preventDefault()
          settle(current.kind === 'prompt' ? input : true)
        }}
      >
        <p className="mb-3 text-sm text-ink">{current.message}</p>
        {current.kind === 'prompt' && (
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="mb-3 w-full rounded border border-line bg-bg px-2 py-1.5 text-sm text-ink outline-none focus:border-em"
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => settle(cancelValue)}
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
            {current.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  ) : (
    <></>
  )

  return { confirm, prompt, element }
}
