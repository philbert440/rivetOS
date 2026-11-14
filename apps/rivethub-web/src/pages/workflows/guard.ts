/**
 * The workflows page's unsaved-edits guard: it tracks whether the open editor
 * has unsaved edits and answers whether an action that would throw them away
 * may proceed.
 */

import { create } from 'zustand'
import type { ConfirmFn } from '../../components/confirm-dialog.js'

const DISCARD_OPTS = { confirmLabel: 'Discard', danger: true } as const

interface WorkflowsBufferState {
  /** Whether the open editor has unsaved edits. */
  dirty: boolean
}

const useWorkflowsBuffer = create<WorkflowsBufferState>()(() => ({ dirty: false }))

const openBuffer = (): WorkflowsBufferState => useWorkflowsBuffer.getState()
const clearDirty = (): void => useWorkflowsBuffer.setState({ dirty: false })
/** Prompts when the buffer is dirty; true when the edits may be given up. */
const askDiscard = async (confirm: ConfirmFn): Promise<boolean> => {
  if (!openBuffer().dirty) return true
  const ok = await confirm('Discard unsaved changes?', { ...DISCARD_OPTS })
  if (ok) clearDirty()
  return ok
}

export const workflowsGuard = {
  /** Records whether the open editor has unsaved edits. */
  report: (dirty: boolean): void => {
    useWorkflowsBuffer.setState({ dirty })
  },

  /** Whether the open editor has unsaved edits. */
  isDirty: (): boolean => openBuffer().dirty,

  /** Asks before an action that leaves the editor. true = it may proceed. */
  confirmDiscard: async (confirm: ConfirmFn): Promise<boolean> => askDiscard(confirm),

  /** Asks before leaving the page. true = the leave may proceed. */
  confirmLeave: async (confirm: ConfirmFn): Promise<boolean> => askDiscard(confirm),
}
