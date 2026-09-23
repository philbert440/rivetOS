import { afterEach, describe, expect, it, vi } from 'vitest'
import { dialogOnScreen, parseBlockingDialog } from './blocking-dialog.js'
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
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  it('ignores a numbered list and a footer-like phrase above the live input box', () => {
    // The phrase is a real footer match, so this reaches the post-footer
    // check instead of short-circuiting on "no footer".
    const screen = `\
● Done.

1. Close RivetHub when you are finished.
2. Check whether Obsidian is running.
…press Esc to cancel

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
    expect(parseBlockingDialog(screen)).toBeUndefined()
  })

  it('ignores a quoted menu with a literal ❯ row once scrollback follows it', () => {
    const screen = `\
● Quoted the picker back:

  1. Yes
  ❯ 2. Not now
  3. Don't show again
  …press Esc to cancel

● And then the reply continued in normal scrollback.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
    expect(parseBlockingDialog(screen)).toBeUndefined()
  })

  it('stops the option walk on a predecessor-key gap (7 then 1)', () => {
    const screen = AUTO_MODE_DIALOG_SCREEN.replace('    2. Not now', '    7. Not now').replace(
      "    3. Don't show again\n",
      '',
    )
    expect(parseBlockingDialog(screen)).toBeUndefined()
  })

  it('logs at debug when a footer matches but the tail check rejects', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      expect(parseBlockingDialog(OLD_DIALOG_SCROLLBACK_SCREEN)).toBeUndefined()
      expect(debug).toHaveBeenCalled()
      expect(String(debug.mock.calls[0]?.[0])).toContain('post-footer check rejected')
    } finally {
      debug.mockRestore()
    }
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

  it('permission and AskUserQuestion captures have no composer between footer and chrome', () => {
    // Real screens replace the composer. The menu matches on that path, not
    // because a question line sits above the options.
    const footer = /Enter to (confirm|select|continue)|Esc to (cancel|go back|exit)/
    for (const screen of [CLAUDE_PERM_SCREEN, CLAUDE_PICKER_SCREEN]) {
      const lines = screen.split('\n')
      let footerIdx = -1
      for (let i = lines.length - 1; i >= 0; i--) {
        if (footer.test(lines[i])) {
          footerIdx = i
          break
        }
      }
      expect(footerIdx).toBeGreaterThanOrEqual(0)
      expect(lines.slice(footerIdx + 1).some((line) => /^\s*❯\s*$/.test(line))).toBe(false)
      expect(parseBlockingDialog(screen)).toBeDefined()
    }
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

  it('ignores an assistant reply that quotes a dialog above the live input box', () => {
    // GLM trace. The composer is still up (empty ❯ under the footer) and no
    // box-drawing rule frames the quoted menu, so this is not a live dialog.
    const screen = `\
● The prompt at the bottom of the tool looks like this:

  ❯ 1. Yes
    2. No
  Enter to confirm · Esc to cancel
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
    expect(parseBlockingDialog(screen)).toBeUndefined()
  })

  it('ignores a quoted menu that includes the question line above the live composer', () => {
    // Round-3 false positive. The question sits on the options, but there is
    // no box rule, and the composer is still up — a reply, not a live dialog.
    const screen = `\
● The prompt at the bottom of the tool looks like this:

  Do you want to proceed?
  ❯ 1. Yes
    2. No
  Enter to confirm · Esc to cancel
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
    expect(parseBlockingDialog(screen)).toBeUndefined()
  })

  it('detects the live dialog when a stale ❯ row is separated from it by a blank line', () => {
    const screen = AUTO_MODE_DIALOG_SCREEN.replace(
      '  ❯ 1. Yes\n',
      '  ❯ 1. Red\n    2. Green\n\n  ❯ 1. Yes\n',
    )
    expect(parseBlockingDialog(screen)).toEqual(AUTO_MODE_RESULT)
  })

  it('does not glue a column-0 numbered list directly above the dialog options', () => {
    const screen = AUTO_MODE_DIALOG_SCREEN.replace(
      '  ❯ 1. Yes\n',
      '1. Close RivetHub when you are not working on it.\n2. Check whether Obsidian settles down.\n  ❯ 1. Yes\n',
    )
    // Above a live composer, unindented prose breaks the dialog frame.
    expect(parseBlockingDialog(screen)).toBeUndefined()
    // Without a composer the option walk still excludes the other column.
    expect(parseBlockingDialog(screen.replace('\n❯\n', '\n'))).toEqual(AUTO_MODE_RESULT)
  })

  it('does not treat a "- item" list line as a separator', () => {
    const screen = AUTO_MODE_DIALOG_SCREEN.replace('\n❯\n', '\n- item\n❯\n')
    expect(parseBlockingDialog(screen)).toBeUndefined()
  })

  it('does not treat a reply line that says "for agents" as composer chrome', () => {
    const screen = AUTO_MODE_DIALOG_SCREEN.replace(
      '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
      'notes for agents',
    )
    expect(parseBlockingDialog(screen)).toBeUndefined()
  })

  it('still detects the /model picker when one extra chrome row sits above the footer', () => {
    const screen = MODEL_PICKER_SCREEN.replace(
      '\n   Enter to set as default',
      '\n   extra chrome row\n   Enter to set as default',
    )
    expect(parseBlockingDialog(screen)?.options.map((o) => o.key)).toEqual([
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
  })

  it('logs at debug when no option row is within 10 lines of the footer', () => {
    const screen = `  ❯ 1. Yes\n    2. No\n${'\n'.repeat(12)}Enter to confirm · Esc to cancel\n`
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      expect(parseBlockingDialog(screen)).toBeUndefined()
      expect(String(debug.mock.calls[0]?.[0])).toContain('no option row')
    } finally {
      debug.mockRestore()
    }
  })

  it('logs at debug when the option walk breaks on a predecessor-key gap', () => {
    const screen = AUTO_MODE_DIALOG_SCREEN.replace('    2. Not now', '    7. Not now').replace(
      "    3. Don't show again\n",
      '',
    )
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      expect(parseBlockingDialog(screen)).toBeUndefined()
      expect(String(debug.mock.calls[0]?.[0])).toContain('option walk rejected (predecessor)')
    } finally {
      debug.mockRestore()
    }
  })

  it('detects an auto-mode dialog whose explanation body is longer than a fixed line cap', () => {
    const body = Array.from({ length: 8 }, (_, n) => `  explanation line ${n + 1}`).join('\n')
    const screen = AUTO_MODE_DIALOG_SCREEN.replace(
      '  Auto mode works better when it knows your environment. Takes about a minute.',
      body,
    )
    expect(parseBlockingDialog(screen)).toEqual(AUTO_MODE_RESULT)
  })

  it.each(['● Assistant reply', '  ⏺ Assistant reply', 'Unindented reply', '1. Unindented list'])(
    'stops the rule walk at %s even with a rule above it',
    (boundary) => {
      const screen = `\
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
${boundary}

  Do you want to proceed?
  ❯ 1. Yes
    2. No
  Enter to confirm · Esc to cancel
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
      expect(parseBlockingDialog(screen)).toBeUndefined()
    },
  )

  it('does not treat a box rule past the safety cap as framing a menu', () => {
    const gap = Array.from({ length: 45 }, () => '  quoted body line').join('\n')
    const screen = `\
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
${gap}

  ❯ 1. Yes
    2. No
  Enter to confirm · Esc to cancel
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
    expect(parseBlockingDialog(screen)).toBeUndefined()
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

  it.each([
    ['↑', true],
    [' ', false],
  ] as const)('requires ↑ on a scrolled window starting at 3 (marker: %s)', (marker, detected) => {
    const screen = `▔▔▔▔▔▔▔▔▔▔
   Select model

   ${marker} 3. Sonnet
   ❯ 4. Opus
   ↓ 5. Haiku
      … +1 model

   ◐ Medium effort (default) ←/→ to adjust

   Enter to set as default · Esc to cancel
`
    const dialog = parseBlockingDialog(screen)
    if (detected) {
      expect(dialog).toEqual({
        title: 'Select model',
        options: [
          { key: '3', label: 'Sonnet' },
          { key: '4', label: 'Opus' },
          { key: '5', label: 'Haiku' },
        ],
      })
    } else {
      expect(dialog).toBeUndefined()
    }
  })

  it('returns undefined for an empty screen', () => {
    expect(parseBlockingDialog('')).toBeUndefined()
  })
})

describe('dialogOnScreen (legacy POST /term/inject gate)', () => {
  it('finds the dialog on the screen it reads', async () => {
    expect(await dialogOnScreen(() => Promise.resolve(MODEL_PICKER_SCREEN))).toMatchObject({
      title: 'Select model',
    })
  })

  it('fails open on an idle screen, an empty read, and a read error', async () => {
    expect(await dialogOnScreen(() => IDLE_HARNESS_SCREEN)).toBeUndefined()
    expect(await dialogOnScreen(() => '')).toBeUndefined()
    expect(
      await dialogOnScreen(() => Promise.reject(new Error('pane read failed'))),
    ).toBeUndefined()
  })
})
