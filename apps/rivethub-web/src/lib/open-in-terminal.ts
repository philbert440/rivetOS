import type { TermAttachInfo } from '@rivetos/types'
import { attachArgv, attachCommandString } from './attach-command.js'
import { rivetShell, type RivetShell } from './shell-bridge.js'

/** Electron path: shell bridge present AND `openInTerminal` is defined. */
export function canOpenInTerminal(
  shell: RivetShell | undefined = rivetShell(),
): shell is RivetShell & { openInTerminal: (attach: TermAttachInfo) => Promise<void> } {
  return typeof shell?.openInTerminal === 'function'
}

/** Copy-pasteable attach command for the web/mobile fallback. */
export function fallbackAttachCommand(attach: TermAttachInfo): string {
  return attachCommandString(attachArgv(attach))
}

/**
 * Launch via the Electron bridge. Rejects when the bridge is absent or the
 * main-process spawn fails — callers show the existing error pattern.
 */
export async function openInExternalTerminal(
  attach: TermAttachInfo,
  shell: RivetShell | undefined = rivetShell(),
): Promise<void> {
  if (!canOpenInTerminal(shell)) {
    throw new Error('openInTerminal is not available')
  }
  await shell.openInTerminal(attach)
}
