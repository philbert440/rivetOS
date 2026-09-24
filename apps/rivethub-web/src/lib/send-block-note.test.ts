import { describe, expect, it } from 'vitest'
import {
  DIALOG_DISMISSED_NOTICE,
  DIALOG_NOTE,
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
  it('says the message was sent and that a Terminal picker or prompt was cancelled', () => {
    expect(DIALOG_DISMISSED_NOTICE).toMatch(/^sent:/)
    expect(DIALOG_DISMISSED_NOTICE).toMatch(/Terminal/)
    expect(DIALOG_DISMISSED_NOTICE).toMatch(/cancelled \(Esc\)/)
  })
})
