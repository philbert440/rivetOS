import { describe, expect, it } from 'vitest'
import { parseComposerInput } from './composer-input.js'
import {
  AUTO_MODE_DIALOG_SCREEN,
  FRESH_CLAUDE_PROMPT_SCREEN,
  SLASH_DRAFT_SCREEN,
  WRAPPED_DRAFT_SCREEN,
} from './tui-screen-fixtures.js'

/** Composer box. `gap` is the whitespace after `❯` (a regular space or NBSP). */
function composerBox(text: string, gap: string): string {
  return `\
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯${gap}${text}
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
}

/** Claude Code 2.1.280 empty-box ghosts. `<f>` is `<filepath>` or a repo path. */
const EMPTY_BOX_PLACEHOLDERS = [
  'Try "fix lint errors"',
  'Try "fix typecheck errors"',
  'Try "how does <filepath> work?"',
  'Try "how does src/term/composer-input.ts work?"',
  'Try "how does my file.ts work?"',
  'Try "refactor <filepath>"',
  'Try "refactor src/term/composer-input.ts"',
  'Try "refactor my file.ts"',
  'Try "how do I log an error?"',
  'Try "edit <filepath> to..."',
  'Try "edit src/term/composer-input.ts to..."',
  'Try "write a test for <filepath>"',
  'Try "write a test for src/term/composer-input.ts"',
  'Try "create a util logging.py that..."',
  'Message @explore\u2026',
  'Message @code reviewer\u2026',
  'Press Enter to edit the selected message, or up again for history',
  'Press Enter to edit the selected message, or up again for an older one',
  'Press up to select a queued message to edit, or Enter to send them now',
  'Press up to edit queued messages, Enter to send them immediately',
  'Press up to select a queued message, then Enter to edit it',
  'Press up to edit queued messages',
]

describe('parseComposerInput', () => {
  it('returns undefined for an empty input box', () => {
    const screen = `\
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
    expect(parseComposerInput(screen)).toBeUndefined()
  })

  it('returns the typed draft', () => {
    const screen = `\
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ hello there
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
    expect(parseComposerInput(screen)).toBe('hello there')
  })

  it('returns a pasted-text placeholder', () => {
    const screen = `\
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ [Pasted text #1 +12 lines]
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
    expect(parseComposerInput(screen)).toBe('[Pasted text #1 +12 lines]')
  })

  it('does not treat a dialog option row as the input box', () => {
    expect(parseComposerInput(AUTO_MODE_DIALOG_SCREEN)).toBeUndefined()
  })

  it('ignores ❯ inside a reply higher up the screen', () => {
    const screen = `\
● Done.

\`\`\`
❯ not the composer
\`\`\`

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`
    expect(parseComposerInput(screen)).toBeUndefined()
  })
})

describe('parseComposerInput on live captures', () => {
  it('treats a fresh session\'s dim Try "…" example as an empty box', () => {
    expect(parseComposerInput(FRESH_CLAUDE_PROMPT_SCREEN)).toBeUndefined()
  })

  it('reads a typed-but-unsent slash command (non-breaking space after ❯)', () => {
    expect(parseComposerInput(SLASH_DRAFT_SCREEN)).toBe('/model')
  })

  it('still reads real text that merely starts with Try', () => {
    const screen = SLASH_DRAFT_SCREEN.replace('❯\u00a0/model', '❯\u00a0Try this instead')
    expect(parseComposerInput(screen)).toBe('Try this instead')
  })

  it('treats each Claude Code 2.1.280 empty-box placeholder as empty, with NBSP after ❯', () => {
    for (const text of EMPTY_BOX_PLACEHOLDERS) {
      expect(parseComposerInput(composerBox(text, ' ')), text).toBeUndefined()
      expect(parseComposerInput(composerBox(text, '\u00a0')), `nbsp ${text}`).toBeUndefined()
    }
  })

  it('treats Try "foo" as a draft, with NBSP after ❯', () => {
    expect(parseComposerInput(composerBox('Try "foo"', ' '))).toBe('Try "foo"')
    expect(parseComposerInput(composerBox('Try "foo"', '\u00a0'))).toBe('Try "foo"')
  })

  it('treats a Try template that contains a second quote as a draft', () => {
    const text = 'Try "refactor x" then "y"'
    expect(parseComposerInput(composerBox(text, ' '))).toBe(text)
    expect(parseComposerInput(composerBox(text, '\u00a0'))).toBe(text)
  })

  it('does not treat a longer line that merely contains a placeholder as empty', () => {
    expect(parseComposerInput(composerBox('Press up to edit queued messages now', ' '))).toBe(
      'Press up to edit queued messages now',
    )
  })

  it('fails open on a wrapped draft (pinned until the separator block is parsed)', () => {
    expect(parseComposerInput(WRAPPED_DRAFT_SCREEN)).toBeUndefined()
  })
})
