/**
 * Transient UI interaction state: dirty-guard tracking for surfaces with
 * unsaved-edit protection. Ephemeral by design — never persisted, reset when
 * the guarded surface goes away.
 *
 * One sub-key per guarded surface; adding a surface adds a sub-key and its
 * actions here rather than a new module. Do not put preferences or server
 * state in this store: those live in their own zustand modules.
 */

import { create } from 'zustand'

export interface FilesDirtyState {
  /** The file the guard is tracking; '' = no file open. */
  fileName: string
  /** The open buffer has unsaved edits. */
  dirty: boolean
  /** A discard decision is being asked; intent is the action that triggered it. */
  pending: { intent: string } | null
}

interface UiInteractionState {
  filesDirty: FilesDirtyState
  /** The editor started tracking a file (opened in the preview pane). */
  trackFilesDirty: (fileName: string) => void
  /** The editor reports buffer divergence. */
  setFilesDirty: (dirty: boolean) => void
  /** A discard decision was asked for the tracked file. */
  promptFilesDirty: (intent: string) => void
  /** The user answered: discard clears dirty, cancel keeps it. */
  answerFilesDirty: (discard: boolean) => void
  /** The tracked buffer was saved, switched, or destroyed. */
  clearFilesDirty: () => void
}

const emptyFilesDirty: FilesDirtyState = { fileName: '', dirty: false, pending: null }

export const useUiInteraction = create<UiInteractionState>()((set) => ({
  filesDirty: { ...emptyFilesDirty },
  trackFilesDirty: (fileName) => set((s) => ({ filesDirty: { ...s.filesDirty, fileName } })),
  setFilesDirty: (dirty) =>
    set((s) => ({
      filesDirty: { ...s.filesDirty, dirty, pending: dirty ? s.filesDirty.pending : null },
    })),
  promptFilesDirty: (intent) =>
    set((s) => ({ filesDirty: { ...s.filesDirty, pending: { intent } } })),
  answerFilesDirty: (discard) =>
    set((s) => ({
      filesDirty: {
        ...s.filesDirty,
        dirty: discard ? false : s.filesDirty.dirty,
        pending: null,
      },
    })),
  clearFilesDirty: () => set(() => ({ filesDirty: { ...emptyFilesDirty } })),
}))
