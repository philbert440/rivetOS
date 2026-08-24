import { describe, it, expect } from 'vitest'
import { splitHermesReasoning, stripAnsi } from './hermes-reasoning.js'

const HEADER =
  '┌─ Reasoning ──────────────────────────────────────────────────────────────────────────────────────┐'
const FOOTER =
  '└──────────────────────────────────────────────────────────────────────────────────────────────────┘'

describe('splitHermesReasoning', () => {
  it('returns empty input unchanged', () => {
    expect(splitHermesReasoning('')).toEqual({ reasoning: '', text: '' })
  })

  it('leaves a normal reply alone', () => {
    expect(splitHermesReasoning('The parser is in src/parse.ts.')).toEqual({
      reasoning: '',
      text: 'The parser is in src/parse.ts.',
    })
  })

  it('strips the TUI box and keeps the reply', () => {
    const raw = [HEADER, '│ The user wants the leak fixed.', '│ Check the den hook.', FOOTER, '', 'Fixed.'].join(
      '\n',
    )
    expect(splitHermesReasoning(raw)).toEqual({
      reasoning: 'The user wants the leak fixed.\nCheck the den hook.',
      text: 'Fixed.',
    })
  })

  it('quiet-mode header with no │ body stops at the blank line', () => {
    const raw = [HEADER, 'The user asked about X.', '', 'Here is the answer.'].join('\n')
    expect(splitHermesReasoning(raw)).toEqual({
      reasoning: 'The user asked about X.',
      text: 'Here is the answer.',
    })
  })

  it('a box-only payload is all reasoning', () => {
    const raw = [HEADER, '│ only thinking', FOOTER].join('\n')
    expect(splitHermesReasoning(raw)).toEqual({ reasoning: 'only thinking', text: '' })
  })

  it('still matches when the TUI wraps the header in ANSI', () => {
    const raw = [`\u001b[90m${HEADER}\u001b[0m`, '│ think', FOOTER, 'hi'].join('\n')
    expect(splitHermesReasoning(raw)).toEqual({ reasoning: 'think', text: 'hi' })
    expect(stripAnsi(`\u001b[31mred\u001b[0m`)).toBe('red')
  })
})
