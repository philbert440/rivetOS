import { describe, it, expect } from 'vitest'
import {
  chipsFromLiveTools,
  extractAskUserOptions,
  isAskUserTool,
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

describe('extractAskUserOptions', () => {
  it('extracts nested Claude questions[].options[].label', () => {
    const opts = extractAskUserOptions({
      questions: [
        {
          question: 'Pick one',
          options: [{ label: 'Ship it' }, { label: 'Wait' }],
        },
      ],
    })
    expect(opts).toEqual(['Ship it', 'Wait'])
  })

  it('extracts flat options / choices (Grok + RivetOS)', () => {
    expect(extractAskUserOptions({ options: ['A', 'B'] })).toEqual(['A', 'B'])
    expect(extractAskUserOptions({ choices: ['yes', 'no'] })).toEqual(['yes', 'no'])
    expect(extractAskUserOptions({ options: [{ label: 'X' }] })).toEqual(['X'])
  })

  it('yes_no without choices yields Yes/No', () => {
    expect(extractAskUserOptions({ type: 'yes_no', question: '?' })).toEqual(['Yes', 'No'])
  })

  it('degrades on missing/malformed args without throwing', () => {
    expect(extractAskUserOptions(undefined)).toEqual([])
    expect(extractAskUserOptions(null)).toEqual([])
    expect(extractAskUserOptions('not-json')).toEqual([])
    expect(extractAskUserOptions({ questions: 'nope' })).toEqual([])
  })

  it('parses JSON string args', () => {
    expect(extractAskUserOptions(JSON.stringify({ choices: ['1', '2'] }))).toEqual(['1', '2'])
  })
})

describe('chipsFromLiveTools', () => {
  it('uses the last ask-user tool with options', () => {
    const chips = chipsFromLiveTools([
      { name: 'Bash', status: 'done' },
      {
        name: 'AskUserQuestion',
        status: 'running',
        args: { questions: [{ options: [{ label: 'Go' }, { label: 'Stop' }] }] },
      },
    ])
    expect(chips).toEqual(['Go', 'Stop'])
  })

  it('returns empty when no args (degrade)', () => {
    expect(chipsFromLiveTools([{ name: 'ask_user_question', status: 'running' }])).toEqual([])
  })

  it('hides chips once the ask tool is done', () => {
    expect(
      chipsFromLiveTools([
        {
          name: 'AskUserQuestion',
          status: 'done',
          args: { questions: [{ options: [{ label: 'Go' }] }] },
        },
      ]),
    ).toEqual([])
  })
})
