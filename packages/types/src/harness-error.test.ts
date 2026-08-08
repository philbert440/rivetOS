import { describe, it, expect } from 'vitest'
import { HARNESS_ERROR_CODES, HarnessError, RivetError } from './errors.js'

/** These defaults are gateway-facing: `retryable` drives whether a client is
 *  told to try again, and `context` lands in structured logs. Pinned so a
 *  driver refactor can't quietly turn a retry hint off. */
describe('HarnessError', () => {
  it('is a RivetError carrying the contract wire code', () => {
    const err = new HarnessError('unknown_approval', 'no such approval')
    expect(err).toBeInstanceOf(RivetError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('HarnessError')
    expect(err.code).toBe('unknown_approval')
    expect(err.message).toBe('no such approval')
  })

  it('defaults turn_in_flight to transient/retryable and everything else to error/non-retryable', () => {
    const err = new HarnessError('turn_in_flight', 'a turn is already running')
    expect(err.severity).toBe('transient')
    expect(err.retryable).toBe(true)

    for (const code of HARNESS_ERROR_CODES.filter((c) => c !== 'turn_in_flight')) {
      const other = new HarnessError(code, code)
      expect(other.severity, code).toBe('error')
      expect(other.retryable, code).toBe(false)
    }
  })

  it('lets the caller override severity and retryable', () => {
    const err = new HarnessError('capability_unsupported', 'no interrupt', {
      severity: 'warning',
      retryable: true,
    })
    expect(err.severity).toBe('warning')
    expect(err.retryable).toBe(true)
  })

  it('merges harnessId/sessionId into context and exposes them as fields', () => {
    const err = new HarnessError('session_id_collision', 'native id already exists', {
      harnessId: 'claude-code',
      sessionId: 'claude-code:a1b2',
      context: { attempt: 2 },
    })
    expect(err.harnessId).toBe('claude-code')
    expect(err.sessionId).toBe('claude-code:a1b2')
    expect(err.context).toEqual({
      attempt: 2,
      harnessId: 'claude-code',
      sessionId: 'claude-code:a1b2',
    })
  })

  it('omits absent harnessId/sessionId keys rather than writing undefined', () => {
    const err = new HarnessError('invalid_session_id', 'bad id', { context: { id: ' x:y' } })
    expect(err.context).toEqual({ id: ' x:y' })
    expect(err.harnessId).toBeUndefined()
    expect(err.sessionId).toBeUndefined()
  })

  it('serializes code, severity and retryable for structured logs', () => {
    const json = new HarnessError('turn_in_flight', 'busy', {
      sessionId: 'hermes:9b41',
      cause: new Error('root cause'),
    }).toJSON()
    expect(json).toMatchObject({
      name: 'HarnessError',
      code: 'turn_in_flight',
      message: 'busy',
      severity: 'transient',
      retryable: true,
      cause: 'root cause',
      context: { sessionId: 'hermes:9b41' },
    })
  })
})
