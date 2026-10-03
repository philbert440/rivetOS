/**
 * Pure discard / navigation decisions for the Files page editor.
 * Call sites inject confirm + clearDirty; tests use a fake confirm.
 */

export type DiscardConfirm = (
  message: string,
  opts?: { confirmLabel?: string; danger?: boolean },
) => Promise<boolean>

export type GuardResult = 'proceed' | 'cancel' | 'noop'

export const DISCARD_CONFIRM_OPTS = { confirmLabel: 'Discard', danger: true } as const

export function discardMessage(fileName?: string): string {
  const name = fileName?.trim()
  return name ? `Discard unsaved changes to ${name}?` : 'Discard unsaved changes?'
}

/** Prompt when dirty. On OK, clearDirty then return true. Clean → true, no prompt. */
export async function confirmDiscard(args: {
  dirty: boolean
  fileName?: string
  confirm: DiscardConfirm
  clearDirty: () => void
}): Promise<boolean> {
  if (!args.dirty) return true
  const ok = await args.confirm(discardMessage(args.fileName), { ...DISCARD_CONFIRM_OPTS })
  if (ok) args.clearDirty()
  return ok
}

/**
 * Directory / breadcrumb navigation. Same-path is a no-op BEFORE confirm so
 * an accepted discard cannot clear dirty while the pane stays open.
 * When dirty, callers that change the URL should let the router blocker
 * prompt; this helper only decides same-path vs proceed.
 */
export function guardPathNav(currentPath: string, nextPath: string): GuardResult {
  if (nextPath === currentPath) return 'noop'
  return 'proceed'
}

/** Open a file in the preview pane (replaces the buffer). Same-file is a no-op. */
export async function guardOpenFile(args: {
  dirty: boolean
  previewPath: string | undefined
  child: string
  fileName?: string
  confirm: DiscardConfirm
  clearDirty: () => void
}): Promise<GuardResult> {
  if (args.child === args.previewPath) return 'noop'
  if (!(await confirmDiscard(args))) return 'cancel'
  return 'proceed'
}

/** Close the preview pane. */
export async function guardClosePreview(args: {
  dirty: boolean
  fileName?: string
  confirm: DiscardConfirm
  clearDirty: () => void
}): Promise<GuardResult> {
  if (!(await confirmDiscard(args))) return 'cancel'
  return 'proceed'
}

/**
 * Router blocker: return true to BLOCK the navigation.
 * On Discard, clearDirty runs so the leave proceeds without a second prompt.
 */
export async function shouldBlockFilesLeave(args: {
  dirty: boolean
  fileName?: string
  confirm: DiscardConfirm
  clearDirty: () => void
}): Promise<boolean> {
  if (!args.dirty) return false
  const ok = await confirmDiscard(args)
  return !ok
}

/**
 * Row click / double-click filters: checkbox cell, multi-click of a
 * double-click sequence, and drag-select of a filename must not open.
 */
export function shouldIgnoreRowActivate(ev: {
  detail: number
  target: EventTarget | null
  selectionText?: string | null
}): boolean {
  if (ev.detail > 1) return true
  if (ev.selectionText != null && ev.selectionText !== '') return true
  const el = ev.target as HTMLElement | null
  if (el != null && el.closest('[data-no-open]')) return true
  return false
}
