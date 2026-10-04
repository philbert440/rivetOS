import { useCallback, useRef, type ReactNode } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { confirmDiscard, shouldBlockFilesLeave } from '../lib/files-dirty-guard.js'
import { useConfirmDialog } from '../components/confirm-dialog.js'

/**
 * Shared unsaved-edit guard for workflows surfaces. Single source: one dirty
 * ref, one confirm, one router blocker with beforeunload. Callers get a
 * `confirmDiscard()` that prompts only when dirty and clears on accept.
 *
 * The caller must render `element`: it is the confirm dialog. Without it a
 * prompt is asked and nothing can answer it, so a guarded leave never settles.
 */
export function useWorkflowDirtyGuard(): {
  markDirty: (dirty: boolean) => void
  confirmDiscard: (fileName?: string) => Promise<boolean>
  isDirty: () => boolean
  /** The discard dialog; render it once in the page. */
  element: ReactNode
} {
  const dirtyRef = useRef(false)
  const discardDialog = useConfirmDialog()
  const discardConfirm = discardDialog.confirm

  const markDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
  }, [])

  const confirm = useCallback(
    async (fileName?: string): Promise<boolean> =>
      confirmDiscard({
        dirty: dirtyRef.current,
        fileName,
        confirm: discardConfirm,
        clearDirty: () => {
          dirtyRef.current = false
        },
      }),
    [discardConfirm],
  )

  const shouldBlockFn = useCallback(
    async () =>
      shouldBlockFilesLeave({
        dirty: dirtyRef.current,
        confirm: discardConfirm,
        clearDirty: () => {
          dirtyRef.current = false
        },
      }),
    [discardConfirm],
  )
  const enableBeforeUnload = useCallback(() => dirtyRef.current, [])

  useBlocker({ shouldBlockFn, enableBeforeUnload })

  // Tab close and reload are covered by the blocker's `enableBeforeUnload`,
  // as on the Files page.
  return {
    markDirty,
    confirmDiscard: confirm,
    isDirty: () => dirtyRef.current,
    element: discardDialog.element,
  }
}
