import { describe, it, expect } from 'vitest'
import {
  foldStream,
  nextReasoningText,
  REASONING_TEXT_MAX,
  type LiveTurn,
} from './fold-stream.js'
import type { StreamEvent } from '@rivetos/types'

function ev(partial: StreamEvent): StreamEvent {
  return partial
}

describe('foldStream', () => {
  it('accumulates text and reasoning text separately', () => {
    let t: LiveTurn | undefined
    t = foldStream(t, ev({ type: 'reasoning', content: 'hmm ' }))
    t = foldStream(t, ev({ type: 'reasoning', content: 'ok' }))
    t = foldStream(t, ev({ type: 'text', content: 'Hello' }))
    expect(t?.reasoningText).toBe('hmm ok')
    expect(t?.text).toBe('Hello')
    expect(t?.reasoning).toBe(false)
  })

  it('spinner-style reasoning lines replace, not accumulate (claude den hook)', () => {
    let t: LiveTurn | undefined
    t = foldStream(t, ev({ type: 'reasoning', content: '\u2733 Wrangling\u2026 (0s \u00b7 \u2193 0 tokens)' }))
    t = foldStream(t, ev({ type: 'reasoning', content: '\u2722 Wrangling\u2026 (5s \u00b7 \u2193 120 tokens)' }))
    expect(t?.reasoningText).toBe('\u2722 Wrangling\u2026 (5s \u00b7 \u2193 120 tokens)')
    // real thinking text still appends
    t = foldStream(undefined, ev({ type: 'reasoning', content: 'first ' }))
    t = foldStream(t, ev({ type: 'reasoning', content: 'second' }))
    expect(t?.reasoningText).toBe('first second')
  })

  it('builds a multi-entry tool stack with running→done', () => {
    let t: LiveTurn | undefined
    t = foldStream(
      t,
      ev({
        type: 'tool_start',
        content: 'Bash',
        metadata: { tool: 'Bash', args: { command: 'ls' } },
      }),
    )
    t = foldStream(
      t,
      ev({
        type: 'tool_start',
        content: 'Read',
        metadata: { tool: 'Read', args: { file_path: '/a/b.ts' } },
      }),
    )
    expect(t?.tools).toHaveLength(2)
    expect(t?.tools[0].status).toBe('running')
    expect(t?.tools[0].title).toContain('Ran:')
    expect(t?.tools[1].title).toBe('Read b.ts')

    t = foldStream(t, ev({ type: 'tool_result', content: 'Bash', metadata: { tool: 'Bash' } }))
    expect(t?.tools[0].status).toBe('done')
    expect(t?.tools[1].status).toBe('running')

    t = foldStream(t, ev({ type: 'tool_result', content: 'Read', metadata: { tool: 'Read' } }))
    expect(t?.tools.every((x) => x.status === 'done')).toBe(true)
  })

  it('does not collapse tools to a single activity-only state', () => {
    let t: LiveTurn | undefined
    t = foldStream(t, ev({ type: 'tool_start', content: 'Grep', metadata: { tool: 'Grep' } }))
    t = foldStream(t, ev({ type: 'tool_result', content: 'Grep', metadata: { tool: 'Grep' } }))
    t = foldStream(t, ev({ type: 'tool_start', content: 'Edit', metadata: { tool: 'Edit' } }))
    expect(t?.tools.map((x) => x.name)).toEqual(['Grep', 'Edit'])
    expect(t?.tools[0].status).toBe('done')
    expect(t?.tools[1].status).toBe('running')
    // activity is a convenience string, not the only storage
    expect(t?.activity).toBeTruthy()
  })

  it('clears the turn on done', () => {
    let t: LiveTurn | undefined = foldStream(undefined, ev({ type: 'text', content: 'x' }))
    t = foldStream(t, ev({ type: 'done', content: '' }))
    expect(t).toBeUndefined()
  })

  it('preserves tool args for ask-user extraction', () => {
    const args = {
      questions: [{ options: [{ label: 'Yes' }, { label: 'No' }] }],
    }
    const t = foldStream(
      undefined,
      ev({
        type: 'tool_start',
        content: 'AskUserQuestion',
        metadata: { tool: 'AskUserQuestion', args },
      }),
    )
    expect(t?.tools[0].args).toEqual(args)
    expect(t?.tools[0].title).toBe('Asked a question')
  })

  it('matches tools-aisdk wire shapes (emoji + name: payload)', () => {
    let t: LiveTurn | undefined
    t = foldStream(t, ev({ type: 'tool_start', content: '🔧 shell', metadata: { tool: 'shell' } }))
    t = foldStream(
      t,
      ev({ type: 'tool_result', content: '✅ shell: Error: not found in file' }),
    )
    // successful ✅ must not be error even if payload contains "Error:"
    expect(t?.tools[0].status).toBe('done')
    expect(t?.tools[0].name).toBe('shell')
  })

  it('marks ❌ tool_result as error without substring-matching "error"', () => {
    let t: LiveTurn | undefined
    t = foldStream(t, ev({ type: 'tool_start', content: 'Bash', metadata: { tool: 'Bash' } }))
    t = foldStream(t, ev({ type: 'tool_result', content: '❌ Bash: boom' }))
    expect(t?.tools[0].status).toBe('error')
  })

  it('does not split MCP tool names on colon when metadata.tool is absent', () => {
    const t = foldStream(
      undefined,
      ev({ type: 'tool_start', content: 'mcp:rivetos:memory_search' }),
    )
    expect(t?.tools[0].name).toBe('mcp:rivetos:memory_search')
  })

  it('caps reasoningText through foldStream while leaving text/tools untouched', () => {
    // Interleaving: long thinking, a tool, more thinking past the cap, then answer text.
    const words = ['a', 'bb', 'ccc', 'dddd', 'eeeeeee', 'ffffffffff', 'ggggg']
    let t: LiveTurn | undefined
    for (let i = 0; i < 800; i++) {
      t = foldStream(t, ev({ type: 'reasoning', content: `${words[i % words.length]} ` }))
    }
    expect(t?.reasoningText.length).toBeLessThanOrEqual(REASONING_TEXT_MAX)
    for (const w of (t?.reasoningText ?? '').trimEnd().split(' ')) {
      expect(words).toContain(w)
    }

    t = foldStream(
      t,
      ev({
        type: 'tool_start',
        content: 'Bash',
        metadata: { tool: 'Bash', args: { command: 'ls' } },
      }),
    )
    t = foldStream(t, ev({ type: 'tool_result', content: 'Bash', metadata: { tool: 'Bash' } }))
    const thoughtAfterTool = t?.reasoningText
    t = foldStream(t, ev({ type: 'text', content: 'answer body' }))
    expect(t?.text).toBe('answer body')
    expect(t?.reasoning).toBe(false)
    // Text path does not clear or re-cap reasoning; tools did not either.
    expect(t?.reasoningText).toBe(thoughtAfterTool)
    expect(t?.tools).toHaveLength(1)
    expect(t?.tools[0].status).toBe('done')
  })
})

describe('nextReasoningText', () => {
  it('exports REASONING_TEXT_MAX as a stable assertable cap (hub > den board)', () => {
    // Den board THOUGHT_MAX is 220; hub transcript shows more. Pin the constant
    // so tests cannot silently drift from the implementation.
    expect(REASONING_TEXT_MAX).toBe(4096)
    expect(REASONING_TEXT_MAX).toBeGreaterThan(220)
  })

  it('appends under the cap unchanged', () => {
    expect(nextReasoningText('hello ', 'world')).toBe('hello world')
    expect(nextReasoningText('', 'only')).toBe('only')

    // Fill close to the cap but stay strictly under — no slide, exact concat.
    const prev = 'x'.repeat(REASONING_TEXT_MAX - 10)
    const out = nextReasoningText(prev, 'yyyyy')
    expect(out).toBe(prev + 'yyyyy')
    expect(out.length).toBe(REASONING_TEXT_MAX - 5)
  })

  it('slides the window and drops the leading partial word when crossing the cap', () => {
    // Construct a full string longer than the cap whose last REASONING_TEXT_MAX
    // chars begin mid-word: "XXXX kept-tail…". After slice(-MAX) the window is
    // full; the den-parity /^\S*\s+/ trim drops "XXXX " so the stream never
    // opens mid-word.
    const partial = 'XXXX'
    const kept = 'kept tail of the thinking stream with spaces'
    const windowBody = partial + ' ' + kept
    const pad = 'p'.repeat(REASONING_TEXT_MAX - windowBody.length)
    const atCap = windowBody + pad
    expect(atCap.length).toBe(REASONING_TEXT_MAX)

    const full = 'DISCARDME ' + atCap
    const previous = full.slice(0, -20)
    const chunk = full.slice(-20)
    const result = nextReasoningText(previous, chunk)

    expect(result).toBe(kept + pad)
    expect(result.length).toBeLessThan(REASONING_TEXT_MAX)
    expect(result.startsWith('kept')).toBe(true)
    expect(result.includes('XXXX')).toBe(false)
    expect(result.includes('DISCARDME')).toBe(false)
  })

  it('word-boundary trim only fires when the sliced window is exactly at cap', () => {
    // Under-cap appends must not lose a leading word via the trim regex.
    expect(nextReasoningText('alpha beta ', 'gamma')).toBe('alpha beta gamma')
  })

  it('spinner replace semantics are never capped or affected', () => {
    const huge = 'a'.repeat(REASONING_TEXT_MAX * 2)
    const spinner = '✳ Wrangling… (28s · ↓ 4.8k tokens)'
    expect(nextReasoningText(huge, spinner)).toBe(spinner)

    // Each spinner glyph in the den/claude set replaces wholesale.
    for (const glyph of ['✳', '✢', '✻', '✽', '·'] as const) {
      const line = `${glyph} Status… (1s · ↓ 1 tokens)`
      expect(nextReasoningText(huge, line)).toBe(line)
    }

    // Even an (unrealistic) over-long spinner-prefixed line is not sliced —
    // only the append path applies REASONING_TEXT_MAX.
    const longSpinner = `✳ ${'x'.repeat(REASONING_TEXT_MAX + 500)}`
    expect(nextReasoningText(huge, longSpinner)).toBe(longSpinner)
    expect(longSpinner.length).toBeGreaterThan(REASONING_TEXT_MAX)
  })

  it('streaming word window never opens mid-word under sustained appends', () => {
    // Variable-length words so slice(-MAX) cannot accidentally land on a
    // boundary — mirrors packages/den-protocol index.test.ts THOUGHT_MAX case.
    const words = ['a', 'bb', 'ccc', 'dddd', 'eeeeeee', 'ffffffffff', 'ggggg']
    let text = ''
    for (let i = 0; i < 800; i++) {
      text = nextReasoningText(text, `${words[i % words.length]} `)
    }
    expect(text.length).toBeLessThanOrEqual(REASONING_TEXT_MAX)
    for (const w of text.trimEnd().split(' ')) {
      expect(words).toContain(w)
    }
  })
})
