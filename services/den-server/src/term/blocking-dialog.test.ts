import { describe, expect, it } from 'vitest'
import { parseBlockingDialog } from './blocking-dialog.js'
import {
  AUTO_MODE_DIALOG_SCREEN,
  CLAUDE_PERM_SCREEN,
  CLAUDE_PICKER_SCREEN,
  IDLE_HARNESS_SCREEN,
  MODEL_PICKER_SCREEN,
  OLD_DIALOG_SCROLLBACK_SCREEN,
} from './tui-screen-fixtures.js'

const AUTO_MODE_RESULT = {
  title: 'Teach auto mode about your environment?',
  options: [
    { key: '1', label: 'Yes' },
    { key: '2', label: 'Not now' },
    { key: '3', label: "Don't show again" },
  ],
}

describe('parseBlockingDialog', () => {
  it('parses the Claude Code 2.1.280 auto-mode dialog', () => {
    expect(parseBlockingDialog(AUTO_MODE_DIALOG_SCREEN)).toEqual(AUTO_MODE_RESULT)
  })

  it('strips ANSI codes via screenLines', () => {
    const ansi = AUTO_MODE_DIALOG_SCREEN.replace(
      'Teach auto mode about your environment?',
      '\x1b[1mTeach auto mode about your environment?\x1b[0m',
    )
    expect(parseBlockingDialog(ansi)).toEqual(AUTO_MODE_RESULT)
  })

  it('normalizes CRLF line endings', () => {
    expect(parseBlockingDialog(AUTO_MODE_DIALOG_SCREEN.replace(/\n/g, '\r\n'))).toEqual(
      AUTO_MODE_RESULT,
    )
  })

  it('ignores an old dialog left in scrollback', () => {
    expect(parseBlockingDialog(OLD_DIALOG_SCROLLBACK_SCREEN)).toBeUndefined()
  })

  it('ignores a normal idle screen', () => {
    expect(parseBlockingDialog(IDLE_HARNESS_SCREEN)).toBeUndefined()
  })

  it('ignores a numbered list inside a reply', () => {
    const screen = `\
● Done.

1. Close RivetHub when you are finished.
2. Check whether Obsidian is running.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
    expect(parseBlockingDialog(screen)).toBeUndefined()
  })

  it('ignores a dialog when the input box has a typed draft', () => {
    const typed = AUTO_MODE_DIALOG_SCREEN.replace(/\n❯\n/, '\n❯ hello there\n')
    expect(parseBlockingDialog(typed)).toBeUndefined()
  })

  it('detects a live permission prompt', () => {
    expect(parseBlockingDialog(CLAUDE_PERM_SCREEN)).toMatchObject({
      options: [
        { key: '1', label: 'Yes' },
        { key: '2', label: "Yes, and don't ask again for mkdir" },
        { key: '3', label: 'No' },
      ],
    })
  })

  it('detects a live AskUserQuestion picker', () => {
    expect(parseBlockingDialog(CLAUDE_PICKER_SCREEN)).toMatchObject({
      options: [
        { key: '1', label: 'Red' },
        { key: '2', label: 'Green' },
        { key: '3', label: 'Blue' },
        { key: '4', label: 'Type something.' },
        { key: '5', label: 'Chat about this' },
      ],
    })
  })

  it('does not glue a numbered list from an earlier reply onto the dialog options', () => {
    const reply = `\
● Next steps:
  1. Close RivetHub when you're not working on it.
  2. Check whether Obsidian settles down.
`
    expect(parseBlockingDialog(reply + AUTO_MODE_DIALOG_SCREEN)).toEqual(AUTO_MODE_RESULT)
  })

  it('still detects the live dialog when an old ❯ row sits higher up the screen', () => {
    const oldPicker = `\
  ❯ 1. Red
    2. Green
`
    expect(parseBlockingDialog(oldPicker + AUTO_MODE_DIALOG_SCREEN)).toEqual(AUTO_MODE_RESULT)
  })

  it('detects the scrolled /model picker (↓ row, rows before the footer, ▔ border)', () => {
    const dialog = parseBlockingDialog(MODEL_PICKER_SCREEN)
    expect(dialog?.title).toBe('Select model')
    expect(dialog?.options.map((o) => o.key)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
    ])
    expect(dialog?.options[1]).toEqual({
      key: '2',
      label: 'Opus 5.5 ✔             Most capable for ambitious work',
    })
  })

  it('returns undefined for an empty screen', () => {
    expect(parseBlockingDialog('')).toBeUndefined()
  })
})
