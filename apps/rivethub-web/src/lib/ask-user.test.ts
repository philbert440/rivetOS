import { describe, it, expect } from 'vitest'
import {
  extractAskUserQuestions,
  isAskUserTool,
  questionsFromLiveTools,
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
          options: [
            { label: 'JWT', description: 'Stateless tokens' },
            { label: 'Sessions' },
          ],
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

  it('dedupes options and caps at 10', () => {
    const qs = extractAskUserQuestions({
      options: ['X', 'X', ...Array.from({ length: 15 }, (_, i) => `o${String(i)}`)],
    })
    expect(qs[0].options.length).toBe(10)
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
