import { describe, expect, it } from 'vitest'
import {
  DIALOG_DISMISSED_NOTICE,
  DIALOG_DISMISSED_NOTICE_MS,
  DIALOG_NOTE,
  dialogDismissedNoticeRemaining,
  dismissedDialogFrom,
  sendBlockNote,
  undeliveredNote,
} from './send-block-note.js'

describe('sendBlockNote', () => {
  it('explains a send refused because the Terminal has a dialog open', () => {
    const err = { status: 409, body: { error: 'x', reason: 'harness_dialog' } }
    expect(sendBlockNote(err)).toBe(DIALOG_NOTE)
    expect(DIALOG_NOTE).toMatch(/picker or prompt/)
  })

  it('stays silent for other errors', () => {
    expect(sendBlockNote({ status: 409, body: { code: 'turn_in_flight' } })).toBeUndefined()
    expect(sendBlockNote({ status: 409, body: 'plain text' })).toBeUndefined()
    expect(sendBlockNote(new Error('network'))).toBeUndefined()
    expect(sendBlockNote(undefined)).toBeUndefined()
  })
})

describe('undeliveredNote', () => {
  it('uses fixed copy without captured pane text', () => {
    expect(
      undeliveredNote(
        'Claude Code is showing a dialog (“Select model”); answer it in the terminal, then retry',
      ),
    ).toBe('not delivered: answer the picker or prompt in Terminal')
    expect(undeliveredNote("Claude Code didn't start working on the message within 4s")).toBe(
      'not delivered: the harness did not start working',
    )
  })

  it('falls back when there is no message', () => {
    expect(undeliveredNote(undefined)).toBe('not delivered: check Terminal before retrying')
  })
})

describe('DIALOG_DISMISSED_NOTICE', () => {
  it('says the message was sent and that a Terminal picker or prompt is cancelled before the paste', () => {
    expect(DIALOG_DISMISSED_NOTICE).toBe(
      'sent: a picker or prompt was open in the Terminal; it is cancelled (Esc) before the paste',
    )
  })
})

describe('dismissedDialogFrom', () => {
  it('reads the flag from either 202 shape and ignores anything else', () => {
    expect(
      dismissedDialogFrom({ ok: true, sessionId: 'claude-code:1', dismissedDialog: true }),
    ).toBe(true)
    expect(dismissedDialogFrom({ ok: true, ptyId: 'pty-1', dismissedDialog: true })).toBe(true)
    expect(dismissedDialogFrom({ ok: true, sessionId: 'claude-code:1' })).toBe(false)
    expect(dismissedDialogFrom({ ok: true, ptyId: 'pty-1' })).toBe(false)
    expect(dismissedDialogFrom({ dismissedDialog: false })).toBe(false)
    expect(dismissedDialogFrom({ dismissedDialog: 'true' })).toBe(false)
    expect(dismissedDialogFrom(undefined)).toBe(false)
    expect(dismissedDialogFrom(null)).toBe(false)
  })
})

describe('dialogDismissedNoticeRemaining', () => {
  const start = 1_000_000

  it('stays up for 8s and is gone at the boundary', () => {
    expect(dialogDismissedNoticeRemaining(undefined, start)).toBeUndefined()
    expect(dialogDismissedNoticeRemaining(start, start)).toBe(DIALOG_DISMISSED_NOTICE_MS)
    expect(dialogDismissedNoticeRemaining(start, start + DIALOG_DISMISSED_NOTICE_MS - 1)).toBe(1)
    expect(
      dialogDismissedNoticeRemaining(start, start + DIALOG_DISMISSED_NOTICE_MS),
    ).toBeUndefined()
    expect(dialogDismissedNoticeRemaining(start, start + DIALOG_DISMISSED_NOTICE_MS + 1)).toBe(
      undefined,
    )
  })
})
