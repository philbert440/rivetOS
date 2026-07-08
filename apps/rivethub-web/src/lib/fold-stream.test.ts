import { describe, it, expect } from 'vitest'
import { foldStream, type LiveTurn } from './fold-stream.js'
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
})
