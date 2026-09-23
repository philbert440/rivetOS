import { describe, expect, it } from 'vitest'
import { parseComposerInput } from './composer-input.js'
import { AUTO_MODE_DIALOG_SCREEN } from './tui-screen-fixtures.js'

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
