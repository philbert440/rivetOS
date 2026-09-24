import { describe, expect, it } from 'vitest'
import { presetSpawnFields, termSpawnBody, termSpawnFallbackBody } from './term-spawn.js'

const preset = { model: 'haiku', effort: 'low' }

describe('termSpawnBody', () => {
  it('includes agentId and omits model and effort that duplicate the preset', () => {
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        command: 'claude',
        resumeSessionId: 'sess-1',
        agentId: 'reviewer',
        model: 'haiku',
        effort: 'low',
        preset,
      }),
    ).toEqual({
      session: 'sess-1',
      command: 'claude',
      resume: 'sess-1',
      agentId: 'reviewer',
    })
  })

  it('keeps an explicit per-thread model or effort that differs from the preset', () => {
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        agentId: 'reviewer',
        model: 'opus',
        effort: 'low',
        preset,
      }),
    ).toEqual({ session: 'sess-1', agentId: 'reviewer', model: 'opus' })
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        agentId: 'reviewer',
        model: 'haiku',
        effort: 'max',
        preset,
      }),
    ).toEqual({ session: 'sess-1', agentId: 'reviewer', effort: 'max' })
  })

  it('sends stored model and effort when the preset is not loaded', () => {
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        agentId: 'reviewer',
        model: 'haiku',
        effort: 'low',
      }),
    ).toEqual({ session: 'sess-1', agentId: 'reviewer', model: 'haiku', effort: 'low' })
  })

  it('does not drop model or effort for a thread with no agentId', () => {
    expect(
      termSpawnBody({
        sessionId: 'sess-1',
        command: 'claude',
        model: 'haiku',
        effort: 'low',
        preset,
      }),
    ).toEqual({ session: 'sess-1', command: 'claude', model: 'haiku', effort: 'low' })
  })
})

describe('termSpawnFallbackBody', () => {
  it('keeps agentId on the 404 fallback', () => {
    expect(termSpawnFallbackBody('sess-1', 'reviewer')).toEqual({
      session: 'sess-1',
      agentId: 'reviewer',
    })
  })

  it('is session-only when there is no preset', () => {
    expect(termSpawnFallbackBody('sess-1')).toEqual({ session: 'sess-1' })
    expect(termSpawnFallbackBody('sess-1', '  ')).toEqual({ session: 'sess-1' })
  })
})

describe('presetSpawnFields', () => {
  it('reads the first cached list that has the preset', () => {
    expect(
      presetSpawnFields('reviewer', [undefined, [{ id: 'other', model: 'x', effort: 'y' }]]),
    ).toBeUndefined()
    expect(
      presetSpawnFields('reviewer', [
        [{ id: 'reviewer', model: 'haiku', effort: 'low' }],
        [{ id: 'reviewer', model: 'opus', effort: 'high' }],
      ]),
    ).toEqual({ model: 'haiku', effort: 'low' })
  })
})
