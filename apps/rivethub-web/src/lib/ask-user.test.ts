import { structuredAskAnswers } from './ask-user.js'
import { describe, it, expect } from 'vitest'
import {
  extractAskUserQuestions,
  isAskUserTool,
  questionsFromLiveTools,
  composeAskAnswer,
  askCardMode,
  askErrorMessage,
  type AskQuestion,
} from './ask-user.js'

describe('isAskUserTool', () => {
  it('recognizes claude, grok, and rivet names', () => {
    expect(isAskUserTool('AskUserQuestion')).toBe(true)
    expect(isAskUserTool('ask_user_question')).toBe(true)
    expect(isAskUserTool('ask_user')).toBe(true)
    expect(isAskUserTool('🔧 ask_user')).toBe(true)
    expect(isAskUserTool('Bash')).toBe(false)
  })
})

describe('extractAskUserQuestions', () => {
  it('extracts nested Claude questions with header/description/multiSelect', () => {
    const qs = extractAskUserQuestions({
      questions: [
        {
          question: 'Which auth method?',
          header: 'Auth method',
          multiSelect: false,
          options: [{ label: 'JWT', description: 'Stateless tokens' }, { label: 'Sessions' }],
        },
        {
          question: 'Enable features?',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    })
    expect(qs).toEqual([
      {
        question: 'Which auth method?',
        header: 'Auth method',
        multiSelect: false,
        options: [{ label: 'JWT', description: 'Stateless tokens' }, { label: 'Sessions' }],
      },
      {
        question: 'Enable features?',
        header: undefined,
        multiSelect: true,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ])
  })

  it('extracts flat options / choices (Grok + RivetOS) as one question', () => {
    expect(extractAskUserQuestions({ question: 'Go?', options: ['A', 'B'] })).toEqual([
      {
        question: 'Go?',
        header: undefined,
        multiSelect: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ])
    expect(extractAskUserQuestions({ choices: ['yes', 'no'] })[0].options).toEqual([
      { label: 'yes' },
      { label: 'no' },
    ])
  })

  it('yes_no without choices yields Yes/No', () => {
    expect(extractAskUserQuestions({ type: 'yes_no', question: 'Ship it?' })).toEqual([
      {
        question: 'Ship it?',
        multiSelect: false,
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ])
  })

  it('dedupes options and caps at 20 (the bridge array cap)', () => {
    const qs = extractAskUserQuestions({
      options: ['X', 'X', ...Array.from({ length: 25 }, (_, i) => `o${String(i)}`)],
    })
    expect(qs[0].options.length).toBe(20)
    expect(qs[0].options[0]).toEqual({ label: 'X' })
  })

  it('degrades on missing/malformed args without throwing', () => {
    expect(extractAskUserQuestions(undefined)).toEqual([])
    expect(extractAskUserQuestions(null)).toEqual([])
    expect(extractAskUserQuestions('not-json')).toEqual([])
    expect(extractAskUserQuestions({ questions: 'nope' })).toEqual([])
    expect(extractAskUserQuestions({ questions: [{ question: 'no options' }] })).toEqual([])
  })

  it('parses JSON string args', () => {
    const qs = extractAskUserQuestions(JSON.stringify({ choices: ['1', '2'] }))
    expect(qs[0].options.map((o) => o.label)).toEqual(['1', '2'])
  })
})

describe('questionsFromLiveTools', () => {
  it('uses the last ask-user tool with questions', () => {
    const qs = questionsFromLiveTools([
      { name: 'Bash', status: 'done' },
      {
        name: 'AskUserQuestion',
        status: 'running',
        args: { questions: [{ question: 'Go?', options: [{ label: 'Go' }, { label: 'Stop' }] }] },
      },
    ])
    expect(qs).toHaveLength(1)
    expect(qs[0].question).toBe('Go?')
    expect(qs[0].options.map((o) => o.label)).toEqual(['Go', 'Stop'])
  })

  it('returns empty when no args (degrade)', () => {
    expect(questionsFromLiveTools([{ name: 'ask_user_question', status: 'running' }])).toEqual([])
  })

  it('keeps questions after the ask tool is done (headless non-blocking ask)', () => {
    // Seamless den: PreToolUse→PostToolUse often finishes immediately; the
    // answer is the next user turn, not a blocked tool_use.
    const qs = questionsFromLiveTools([
      {
        name: 'AskUserQuestion',
        status: 'done',
        args: { questions: [{ options: [{ label: 'Go' }, { label: 'Stop' }] }] },
      },
    ])
    expect(qs[0].options.map((o) => o.label)).toEqual(['Go', 'Stop'])
  })
})

describe('composeAskAnswer', () => {
  const mk = (over: Partial<AskQuestion> = {}): AskQuestion => ({
    multiSelect: false,
    options: [{ label: 'A' }, { label: 'B' }],
    ...over,
  })

  it('joins one question’s labels', () => {
    expect(composeAskAnswer([mk({ multiSelect: true })], { 0: ['A', 'B'] }, '')).toBe('A, B')
  })

  it('prefixes per-question when several are answered', () => {
    const qs = [mk({ header: 'Auth' }), mk({ question: 'Which db?' })]
    expect(composeAskAnswer(qs, { 0: ['A'], 1: ['B'] }, '')).toBe('Auth: A\nWhich db?: B')
  })

  it('free text alone answers', () => {
    expect(composeAskAnswer([mk()], {}, '  my own take  ')).toBe('my own take')
  })

  it('picks and free text COMBINE — typing never drops a selection', () => {
    expect(composeAskAnswer([mk({ multiSelect: true })], { 0: ['A'] }, 'also: be careful')).toBe(
      'A\nalso: be careful',
    )
  })

  it('empty picks + empty text compose nothing', () => {
    expect(composeAskAnswer([mk()], {}, '   ')).toBe('')
  })
})

describe('askCardMode', () => {
  const q = (over: Partial<AskQuestion> = {}): AskQuestion => ({
    multiSelect: false,
    options: [{ label: 'A' }, { label: 'B' }],
    ...over,
  })

  it('answers a normal question with no screen', () => {
    expect(askCardMode(q())).toBe('answer')
  })

  it('is no-options when the option list is empty (wins over screen)', () => {
    expect(askCardMode(q({ options: [] }))).toBe('no-options')
    expect(askCardMode(q({ options: [] }), { current: 2, total: 3 })).toBe('no-options')
  })

  it('answers a non-last screen-read question', () => {
    expect(askCardMode(q(), { current: 0, total: 3 })).toBe('answer')
    expect(askCardMode(q(), { current: 1, total: 3 })).toBe('answer')
  })

  it('is terminal-only for the last single-select of several', () => {
    expect(askCardMode(q(), { current: 2, total: 3 })).toBe('terminal-only')
  })

  it('still answers the last question when it is multiSelect or the only one', () => {
    expect(askCardMode(q({ multiSelect: true }), { current: 2, total: 3 })).toBe('answer')
    expect(askCardMode(q(), { current: 0, total: 1 })).toBe('answer')
  })
})

describe('askErrorMessage', () => {
  it('prefers Error.message (den bad_request text on GatewayError)', () => {
    expect(askErrorMessage(new Error('answer this one in the terminal'))).toBe(
      'answer this one in the terminal',
    )
  })

  it('reads body.error when message is missing', () => {
    expect(
      askErrorMessage({ body: { error: 'free text with several questions is not supported' } }),
    ).toBe('free text with several questions is not supported')
  })
})

it('native text questions remain answerable without visible options', () => {
  expect(askCardMode({ options: [], multiSelect: false, freeText: true })).toBe('answer')
})
it('keeps text with its question and combines it with selected labels', () => {
  expect(
    structuredAskAnswers(
      [
        { options: [{ label: 'Blue' }], multiSelect: false, freeText: true },
        { options: [], multiSelect: false, freeText: true },
      ],
      { 0: ['Blue'] },
      { 0: ' ocean ', 1: ' Rivet ' },
    ),
  ).toEqual([
    { question: 0, labels: ['Blue'], other: 'ocean' },
    { question: 1, labels: [], other: 'Rivet' },
  ])
})
