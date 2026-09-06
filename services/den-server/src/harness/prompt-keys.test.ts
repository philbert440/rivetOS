import { describe, expect, it } from 'vitest'
import { HarnessError, type HarnessAskQuestion } from '@rivetos/types'
import {
  CLAUDE_TUI_KEYS_VERIFIED,
  claudeApprovalKeys,
  claudeAskAnswerKeys,
  grokApprovalKeys,
} from './prompt-keys.js'

function decode(chunks: Uint8Array[]): string[] {
  const td = new TextDecoder()
  return chunks.map((c) => td.decode(c))
}

const TWO_Q: HarnessAskQuestion[] = [
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
  {
    question: 'Which toppings do you want?',
    header: 'Toppings',
    multiSelect: true,
    options: [{ label: 'Cheese' }, { label: 'Pepperoni' }, { label: 'Peppers' }],
  },
]

describe('claudeAskAnswerKeys', () => {
  it('pins the verified Claude Code version', () => {
    expect(CLAUDE_TUI_KEYS_VERIFIED).toBe('2.1.263')
  })

  it('two-question example: Green, Cheese+Peppers, Tab, Submit', () => {
    const keys = claudeAskAnswerKeys(TWO_Q, [
      { question: 0, labels: ['Green'] },
      { question: 1, labels: ['Cheese', 'Peppers'] },
    ])
    expect(decode(keys)).toEqual(['2', '1', '3', '\t', '1'])
  })

  it('single question digit pick has no Submit tab', () => {
    const keys = claudeAskAnswerKeys([TWO_Q[0]!], [{ question: 0, labels: ['Green'] }])
    expect(decode(keys)).toEqual(['2'])
  })

  it('single question Other is digit, text, Enter — no extra Enter', () => {
    const fruit: HarnessAskQuestion[] = [
      {
        question: 'What fruit do you prefer?',
        multiSelect: false,
        options: [{ label: 'Apple' }, { label: 'Banana' }],
      },
    ]
    const keys = claudeAskAnswerKeys(fruit, [{ question: 0, labels: [], other: 'Mango' }])
    expect(decode(keys)).toEqual(['3', 'Mango', '\r'])
  })

  it('multiSelect with Other toggles then Type-something, text, Enter', () => {
    const q: HarnessAskQuestion[] = [
      {
        question: 'Pick',
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      },
    ]
    const keys = claudeAskAnswerKeys(q, [{ question: 0, labels: ['A', 'C'], other: 'Extra' }])
    expect(decode(keys)).toEqual(['1', '3', '4', 'Extra', '\r'])
  })

  it('unknown label throws bad_request', () => {
    expect(() => claudeAskAnswerKeys([TWO_Q[0]!], [{ question: 0, labels: ['Teal'] }])).toThrow(
      HarnessError,
    )
    try {
      claudeAskAnswerKeys([TWO_Q[0]!], [{ question: 0, labels: ['Teal'] }])
    } catch (err) {
      expect(err).toMatchObject({ code: 'bad_request' })
    }
  })

  it('more than 9 options throws', () => {
    const q: HarnessAskQuestion[] = [
      {
        question: 'many',
        multiSelect: false,
        options: Array.from({ length: 10 }, (_, i) => ({ label: `O${String(i)}` })),
      },
    ]
    expect(() => claudeAskAnswerKeys(q, [{ question: 0, labels: ['O0'] }])).toThrowError(
      HarnessError,
    )
    try {
      claudeAskAnswerKeys(q, [{ question: 0, labels: ['O0'] }])
    } catch (err) {
      expect(err).toMatchObject({ code: 'bad_request' })
    }
  })
})

describe('approval keys', () => {
  it('claude: allow=1 allow-session=2 deny=3', () => {
    expect(decode(claudeApprovalKeys('allow'))).toEqual(['1'])
    expect(decode(claudeApprovalKeys('allow-session'))).toEqual(['2'])
    expect(decode(claudeApprovalKeys('deny'))).toEqual(['3'])
  })

  it('grok: allow-session=1 allow=2 deny=3', () => {
    expect(decode(grokApprovalKeys('allow-session'))).toEqual(['1'])
    expect(decode(grokApprovalKeys('allow'))).toEqual(['2'])
    expect(decode(grokApprovalKeys('deny'))).toEqual(['3'])
  })
})
