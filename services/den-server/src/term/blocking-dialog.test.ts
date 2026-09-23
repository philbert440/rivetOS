import { describe, expect, it } from 'vitest'
import { parseBlockingDialog } from './blocking-dialog.js'
import {
  AUTO_MODE_DIALOG_SCREEN,
  CLAUDE_PERM_SCREEN,
  CLAUDE_PICKER_SCREEN,
  IDLE_HARNESS_SCREEN,
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

  it('returns undefined for an empty screen', () => {
    expect(parseBlockingDialog('')).toBeUndefined()
  })
})
