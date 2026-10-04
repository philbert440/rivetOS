import { useCallback, useEffect, useRef } from 'react'
import { useBlocker } from '@tanstack/react-router'
import { confirmDiscard, shouldBlockFilesLeave } from '../lib/files-dirty-guard.js'
import { useConfirmDialog } from '../components/confirm-dialog.js'

/**
 * Shared unsaved-edit guard for workflows surfaces. Single source: one dirty
 * ref, one confirm, one router blocker with beforeunload. Callers get a
 * `confirmDiscard()` that prompts only when dirty and clears on accept.
 */
export function useWorkflowDirtyGuard(): {
  markDirty: (dirty: boolean) => void
  confirmDiscard: (fileName?: string) => Promise<boolean>
  isDirty: () => boolean
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

  // Tab close / reload backup; the blocker covers in-app route changes.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent): void => {
      if (dirtyRef.current) e.preventDefault()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  return { markDirty, confirmDiscard: confirm, isDirty: () => dirtyRef.current }
}
