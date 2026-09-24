/**
 * Chat copy explaining why a send did not reach the harness, shown on the
 * failed bubble / queued strip instead of a bare "send failed".
 */

/** den refused the paste because the TUI has a picker or prompt open
 *  (`reason: 'harness_dialog'`, from `POST /term/inject` or a harness turn). */
export const DIALOG_NOTE =
  'not sent: the Terminal has a picker or prompt open. Answer it or press Esc there'

/** den refused the paste because the Terminal's input box holds unsent text,
 *  which the paste would be appended to (`reason: 'harness_draft'`). */
export const DRAFT_NOTE =
  'not sent: the Terminal has unsent text in its input. The turn stays queued; press the inject button again once that draft is sent or cleared'

/** The note for a refused send, or undefined when the error carries no known reason. */
export function sendBlockNote(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const body = (err as { body?: unknown }).body
  if (typeof body !== 'object' || body === null) return undefined
  const reason = (body as { reason?: unknown }).reason
  if (reason === 'harness_dialog') return DIALOG_NOTE
  if (reason === 'harness_draft') return DRAFT_NOTE
  return undefined
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

/** Shown after the inject button's send queued Esc for an open picker or
 *  prompt (den answers `dismissedDialog: true`). The Esc has the same delivery
 *  guarantee as the paste — accepted, not proven written (#868). */
export const DIALOG_DISMISSED_NOTICE =
  'sent: a picker or prompt was open in the Terminal; it is cancelled (Esc) before the paste'

/** How long that notice stays up. */
export const DIALOG_DISMISSED_NOTICE_MS = 8_000

/** True when a turn 202 (`accepted`) or a legacy inject 202 (`injected`)
 *  carries `dismissedDialog: true`. Anything else is not a dismissal. */
export function dismissedDialogFrom(
  response: { dismissedDialog?: unknown } | null | undefined,
): boolean {
  return response?.dismissedDialog === true
}

/** Milliseconds the notice should keep showing, or undefined when it was
 *  never started or `now` is already at/past the 8 s mark. */
export function dialogDismissedNoticeRemaining(
  dismissedAt: number | undefined,
  now: number,
): number | undefined {
  if (dismissedAt === undefined) return undefined
  const remaining = dismissedAt + DIALOG_DISMISSED_NOTICE_MS - now
  return remaining > 0 ? remaining : undefined
}
