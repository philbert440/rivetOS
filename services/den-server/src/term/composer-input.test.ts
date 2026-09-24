import { describe, expect, it } from 'vitest'
import { parseComposerInput } from './composer-input.js'
import {
  AUTO_MODE_DIALOG_SCREEN,
  FRESH_CLAUDE_PROMPT_SCREEN,
  SLASH_DRAFT_SCREEN,
} from './tui-screen-fixtures.js'

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
})
