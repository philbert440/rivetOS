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

/** The note for a `turn_undelivered` event: den's own sentence, minus its
 *  trailing retry hint (the bubble adds one). */
export function undeliveredNote(message: string | undefined): string {
  const why = (message ?? '').replace(/[,;]?\s*then retry\.?$/i, '').trim()
  return why ? `not delivered: ${why}` : 'not delivered'
}
