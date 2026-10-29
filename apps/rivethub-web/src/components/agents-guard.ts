/**
 * The agents form's unsaved-edits guard: it tracks which agent is being edited
 * and whether the form has unsaved edits, and answers whether an action that
 * would throw those edits away may proceed.
 */

import { create } from 'zustand'
import type { ConfirmFn } from './confirm-dialog.js'

const DISCARD_OPTS = { confirmLabel: 'Discard', danger: true } as const

interface AgentDraftState {
  /** The agent being edited; '' = a new agent. */
  name: string
  /** Whether the form has unsaved edits. */
  dirty: boolean
}

const useAgentDraft = create<AgentDraftState>()(() => ({ name: '', dirty: false }))

/** The draft being edited. */
const openDraft = (): AgentDraftState => useAgentDraft.getState()
const clearDirty = (): void => useAgentDraft.setState({ dirty: false })
const discardPrompt = (name: string): string =>
  `Discard unsaved changes to agent "${name || 'new agent'}"?`

export const agentsGuard = {
  /** Records which agent is being edited and whether the form has unsaved edits. */
  report: (name: string, dirty: boolean): void => {
    useAgentDraft.setState({ name, dirty })
  },

  /** Whether the form has unsaved edits. */
  isDirty: (): boolean => openDraft().dirty,

  /** Asks before an action that discards the edits. true = it may proceed. */
  confirmDiscard: async (confirm: ConfirmFn): Promise<boolean> => {
    const { name, dirty } = openDraft()
    if (!dirty) return true
    const ok = await confirm(discardPrompt(name), { ...DISCARD_OPTS })
    if (ok) clearDirty()
    return ok
  },
}
