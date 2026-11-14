/**
 * The Files page's unsaved-edits guard: it tracks which file is open and
 * whether that file has unsaved edits, and answers whether an action that would
 * throw those edits away may proceed.
 */

import { create } from 'zustand'
import type { ConfirmFn } from '../../components/confirm-dialog.js'
import { baseName } from '../../lib/files-ui.js'

/** 'noop' = the action asked for nothing; 'cancel' = the edits were kept. */
export type GuardResult = 'proceed' | 'cancel' | 'noop'

const DISCARD_OPTS = { confirmLabel: 'Discard', danger: true } as const

interface FilesBufferState {
  /** The file being tracked. */
  fileName: string | undefined
  /** Whether that file has unsaved edits. */
  dirty: boolean
}

const useFilesBuffer = create<FilesBufferState>()(() => ({ fileName: undefined, dirty: false }))

const openBuffer = (): FilesBufferState => useFilesBuffer.getState()
const clearDirty = (): void => useFilesBuffer.setState({ dirty: false })
/** The tracked file's base name, for prompts. */
const openName = (): string | undefined => {
  const { fileName } = openBuffer()
  return fileName ? baseName(fileName) : undefined
}
const discardPrompt = (fileName?: string): string =>
  fileName ? `Discard unsaved changes to ${fileName}?` : 'Discard unsaved changes?'
/** Prompts when the buffer is dirty; true when the edits may be given up. */
const askDiscard = async (confirm: ConfirmFn): Promise<boolean> => {
  if (!openBuffer().dirty) return true
  const ok = await confirm(discardPrompt(openName()), { ...DISCARD_OPTS })
  if (ok) clearDirty()
  return ok
}

export const filesGuard = {
  /** Tracks `fileName` as the open file, with no unsaved edits. */
  setOpenFile: (fileName: string | undefined): void => {
    useFilesBuffer.setState({ fileName, dirty: false })
  },

  /** Records whether the open file has unsaved edits. */
  report: (dirty: boolean): void => {
    useFilesBuffer.setState({ dirty })
  },

  /** Whether the open file has unsaved edits. */
  isDirty: (): boolean => openBuffer().dirty,

  /** Asks before opening `target`: 'noop' when it is already the open file,
   *  'cancel' when the edits are kept, 'proceed' otherwise. */
  confirmSwitchFile: async (confirm: ConfirmFn, target: string): Promise<GuardResult> => {
    if (target === openBuffer().fileName) return 'noop'
    return (await askDiscard(confirm)) ? 'proceed' : 'cancel'
  },

  /** Asks before closing the open file: 'cancel' when the edits are kept. */
  confirmClosePreview: async (confirm: ConfirmFn): Promise<GuardResult> =>
    (await askDiscard(confirm)) ? 'proceed' : 'cancel',

  /** Asks before leaving the page. true = the leave may proceed. */
  confirmLeave: async (confirm: ConfirmFn): Promise<boolean> => askDiscard(confirm),
}
