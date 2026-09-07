import { describe, expect, it } from 'vitest'
import { parseAskPicker } from './ask-picker.js'

/** Verbatim Claude Code 2.1.263 two-question picker (spike notes). */
const CLAUDE_MULTI = `\
←  ☐ Color  ☐ Toppings  ✔ Submit  →
What color would you like?
❯ 1. Red
     The color red
  2. Green
     The color green
  3. Blue
     The color blue
  4. Type something.
────────────────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`

/** Single question: no tab row; footer uses ↑/↓ rather than Tab/Arrow. */
const CLAUDE_SINGLE = `\
Which color would you like?
❯ 1. Red
     The color red
  2. Green
     The color green
  3. Blue
     The color blue
  4. Type something.
────────────────────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`

const CLAUDE_MULTISELECT = `\
Which toppings do you want?
❯ 1. [ ] Cheese
  2. [ ] Pepperoni
  3. [✔] Peppers
  4. [ ] Type something.
────────────────────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`

const CLAUDE_ANSI = `\x1b[1mWhich color would you like?\x1b[0m
❯ 1. Red
     The color red
  2. Green
  3. Blue
  4. Type something.
Enter to select · ↑/↓ to navigate · Esc to cancel
`

const CLAUDE_PERM = `\
 Bash command
   mkdir -p zz && rm -r zz && echo done
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for mkdir
   3. No
 Esc to cancel · Tab to amend
`

describe('parseAskPicker', () => {
  it('parses a single-question picker (no tab row)', () => {
    expect(parseAskPicker(CLAUDE_SINGLE)).toEqual({
      current: 0,
      questions: [
        {
          question: 'Which color would you like?',
          multiSelect: false,
          options: [
            { label: 'Red', description: 'The color red' },
            { label: 'Green', description: 'The color green' },
            { label: 'Blue', description: 'The color blue' },
          ],
        },
      ],
    })
  })

  it('parses a multi-question tab row; unseen questions have empty options', () => {
    expect(parseAskPicker(CLAUDE_MULTI)).toEqual({
      current: 0,
      questions: [
        {
          question: 'What color would you like?',
          header: 'Color',
          multiSelect: false,
          options: [
            { label: 'Red', description: 'The color red' },
            { label: 'Green', description: 'The color green' },
            { label: 'Blue', description: 'The color blue' },
          ],
        },
        { header: 'Toppings', multiSelect: false, options: [] },
      ],
    })
  })

  it('strips [ ] / [✔] and sets multiSelect', () => {
    expect(parseAskPicker(CLAUDE_MULTISELECT)).toEqual({
      current: 0,
      questions: [
        {
          question: 'Which toppings do you want?',
          multiSelect: true,
          options: [{ label: 'Cheese' }, { label: 'Pepperoni' }, { label: 'Peppers' }],
        },
      ],
    })
  })

  it('strips ANSI before matching anchors', () => {
    const parsed = parseAskPicker(CLAUDE_ANSI)
    expect(parsed?.questions[0]?.question).toBe('Which color would you like?')
    expect(parsed?.questions[0]?.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue'])
  })

  it('returns undefined for permission dialogs and ordinary prose', () => {
    expect(parseAskPicker('')).toBeUndefined()
    expect(parseAskPicker(CLAUDE_PERM)).toBeUndefined()
    expect(parseAskPicker('❯ 1. Red\n  2. Green')).toBeUndefined()
    expect(
      parseAskPicker(
        'Please type something. Enter to select your words carefully.\n1. Red\n2. Green',
      ),
    ).toBeUndefined()
  })

  it('marks the first unanswered tab as current (☒ = already answered)', () => {
    const screen = `\
←  ☒ Color  ☐ Toppings  ✔ Submit  →
Which toppings do you want?
❯ 1. [ ] Cheese
  2. [ ] Pepperoni
  3. [ ] Peppers
  4. [ ] Type something.
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`
    const parsed = parseAskPicker(screen)
    expect(parsed?.current).toBe(1)
    expect(parsed?.questions[0]).toEqual({ header: 'Color', multiSelect: false, options: [] })
    expect(parsed?.questions[1]?.options.map((o) => o.label)).toEqual([
      'Cheese',
      'Pepperoni',
      'Peppers',
    ])
    expect(parsed?.questions[1]?.multiSelect).toBe(true)
  })
})
