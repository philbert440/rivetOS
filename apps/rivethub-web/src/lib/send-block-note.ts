/**
 * Chat copy explaining why a send did not reach the harness, shown on the
 * failed bubble / queued strip instead of a bare "send failed".
 */

/** den refused the paste because the TUI has a picker or prompt open
 *  (`reason: 'harness_dialog'`, from `POST /term/inject` or a harness turn). */
export const DIALOG_NOTE =
  'not sent: the Terminal has a picker or prompt open. Answer it or press Esc there'

/** The note for a refused send, or undefined when the error carries no known reason. */
export function sendBlockNote(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const body = (err as { body?: unknown }).body
  if (typeof body !== 'object' || body === null) return undefined
  return (body as { reason?: unknown }).reason === 'harness_dialog' ? DIALOG_NOTE : undefined
}

/** Only fixed copy reaches the UI: den's reason can contain captured pane text. */
export function undeliveredNote(message: string | undefined): string {
  if (message?.includes('is showing a dialog')) {
    return 'not delivered: answer the picker or prompt in Terminal'
  }
  if (message?.includes("didn't start working")) {
    return 'not delivered: the harness did not start working'
  }
  return 'not delivered: check Terminal before retrying'
}

/** Shown after the inject button's send cancelled an open picker or prompt with
 *  Esc (den answers `dismissedDialog: true`), so the cancel isn't silent (#868). */
export const DIALOG_DISMISSED_NOTICE =
  'sent: a picker or prompt was open in the Terminal and was cancelled (Esc) first'

/** How long that notice stays up. */
export const DIALOG_DISMISSED_NOTICE_MS = 8_000
