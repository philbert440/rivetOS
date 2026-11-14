import { describe, expect, it } from 'vitest'
import type { SessionMessage } from '@rivetos/types'
import {
  activeTurnIndex,
  previewText,
  PROMPT_PREVIEW_CHARS,
  RESPONSE_PREVIEW_CHARS,
  turnLabel,
  turnRailItems,
} from './turn-rail.js'

function msg(
  role: 'user' | 'assistant',
  text: string,
  id = `${role}-${text.slice(0, 8)}`,
): SessionMessage {
  return { id, sessionId: 's', role, text, ts: 1_700_000_000_000 }
}

describe('previewText', () => {
  it('collapses whitespace and strips inline marks', () => {
    expect(previewText('  **bold**  and _it_ `code`\n\nnext  line ', 200)).toBe(
      'bold and it code next line',
    )
  })
  it('drops fenced code and image syntax, keeps link text', () => {
    const src = 'See [docs](https://x.y/z) ![shot](a.png)\n```ts\nconst a = 1\n```\ndone'
    expect(previewText(src, 200)).toBe('See docs done')
  })
  it('unwraps headings, list markers and quotes', () => {
    expect(previewText('# Title\n- one\n2. two\n> quoted', 200)).toBe('Title one two quoted')
  })
  it('clamps on a word boundary with an ellipsis', () => {
    const out = previewText('alpha beta gamma delta epsilon zeta', 20)
    expect(out).toBe('alpha beta gamma…')
    expect(out.length).toBeLessThanOrEqual(21)
  })
  it('hard-cuts when there is no nearby space', () => {
    expect(previewText('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}…`)
  })
  it('returns the input untouched when short', () => {
    expect(previewText('hi', 10)).toBe('hi')
  })
})

describe('turnRailItems', () => {
  it('opens one turn per user message with the first non-empty reply', () => {
    const items = turnRailItems([
      msg('user', 'first question', 'u1'),
      msg('assistant', '', 'a0'),
      msg('assistant', 'the **answer**', 'a1'),
      msg('assistant', 'a follow-up chunk', 'a2'),
      msg('user', 'second', 'u2'),
    ])
    expect(items).toEqual([
      {
        index: 0,
        messageId: 'u1',
        ts: 1_700_000_000_000,
        prompt: 'first question',
        response: 'the answer',
      },
      { index: 1, messageId: 'u2', ts: 1_700_000_000_000, prompt: 'second', response: '' },
    ])
  })
  it('ignores assistant text before any user turn', () => {
    expect(turnRailItems([msg('assistant', 'preamble'), msg('user', 'q')])).toEqual([
      { index: 0, messageId: 'user-q', ts: 1_700_000_000_000, prompt: 'q', response: '' },
    ])
  })
  it('returns nothing for an empty transcript', () => {
    expect(turnRailItems([])).toEqual([])
  })
  it('clamps both previews', () => {
    const items = turnRailItems([
      msg('user', 'w '.repeat(400), 'u'),
      msg('assistant', 'r '.repeat(400), 'a'),
    ])
    expect(items[0]!.prompt.length).toBeLessThanOrEqual(PROMPT_PREVIEW_CHARS + 1)
    expect(items[0]!.response.length).toBeLessThanOrEqual(RESPONSE_PREVIEW_CHARS + 1)
    expect(items[0]!.prompt.endsWith('…')).toBe(true)
  })
})

describe('activeTurnIndex', () => {
  const tops = [0, 500, 1200, 2600]
  it('is null with no turns', () => {
    expect(activeTurnIndex([], 0, 800, 800)).toBeNull()
  })
  it('is the first turn at the top', () => {
    expect(activeTurnIndex(tops, 0, 800, 4000)).toBe(0)
  })
  it('advances when a turn top passes the reading line (20px under the top edge)', () => {
    // line = 300 + 20 = 320 → turn 0 (top 0) is the last at or above it
    expect(activeTurnIndex(tops, 300, 800, 4000)).toBe(0)
    // line = 490 + 20 = 510 → turn 1 (top 500)
    expect(activeTurnIndex(tops, 490, 800, 4000)).toBe(1)
    // a custom line offset: 1175 + 30 = 1205 → turn 2 (top 1200); default 1195 → turn 1
    expect(activeTurnIndex(tops, 1175, 800, 4000, 30)).toBe(2)
    expect(activeTurnIndex(tops, 1175, 800, 4000)).toBe(1)
  })
  it('is the last turn at the floor even when its top is below the line', () => {
    // viewport bottom at the floor; turn 3 top 2600 is below the line (3200+20)
    expect(activeTurnIndex(tops, 3200, 800, 4000)).toBe(3)
    expect(activeTurnIndex(tops, 3197, 800, 4000)).toBe(3)
  })
  it('is the previous turn just above the floor slack', () => {
    expect(activeTurnIndex(tops, 2000, 800, 4000)).toBe(2)
  })
})

describe('turnLabel', () => {
  it('is 1-based', () => {
    expect(turnLabel(0)).toBe('turn 1')
  })
})
