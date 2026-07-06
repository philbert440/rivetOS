import { describe, it, expect } from 'vitest'
import {
  parseTaskResultBlock,
  parseTaskResultJson,
  taskResultFenceInstructions,
} from './task-result.js'

describe('task-result shared parser (2c)', () => {
  it('parses the LAST fence and coerces runner-owned verdicts to failed', () => {
    const text = [
      '```TASK_RESULT\n{"verdict":"completed","summary":"first"}\n```',
      'more work...',
      '```TASK_RESULT\n{"verdict":"timeout","summary":"second"}\n```',
    ].join('\n')
    const parsed = parseTaskResultBlock(text)
    expect(parsed).toMatchObject({ verdict: 'failed', summary: 'second' })
  })

  it('returns undefined on malformed JSON / missing fields / unknown verdicts', () => {
    expect(parseTaskResultBlock('```TASK_RESULT\nnot json\n```')).toBeUndefined()
    expect(parseTaskResultJson('{"summary":"no verdict"}')).toBeUndefined()
    expect(parseTaskResultJson('{"verdict":"vibes","summary":"s"}')).toBeUndefined()
  })

  it('filters malformed artifacts/criteria entries instead of rejecting', () => {
    const parsed = parseTaskResultJson(
      JSON.stringify({
        verdict: 'completed',
        summary: 's',
        artifacts: [{ kind: 'file', ref: 'a.ts' }, { bogus: true }],
        criteriaSelfReport: [{ id: 'c1', met: true }, { id: 42 }],
      }),
    )
    expect(parsed?.artifacts).toEqual([{ kind: 'file', ref: 'a.ts' }])
    expect(parsed?.criteriaSelfReport).toEqual([{ id: 'c1', met: true }])
  })

  it('fence instructions state the completed-when-pausing rule and the fence label', () => {
    const text = taskResultFenceInstructions()
    expect(text).toContain('TASK_RESULT')
    expect(text).toContain('"completed"')
    expect(text).toContain('pausing')
  })
})
