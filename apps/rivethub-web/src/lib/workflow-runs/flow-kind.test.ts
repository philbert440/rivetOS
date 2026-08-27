import { describe, expect, it } from 'vitest'
import { flowNodeFamily } from './flow-kind.js'

describe('flowNodeFamily', () => {
  it('maps start/entry/empty to entry', () => {
    expect(flowNodeFamily(undefined)).toBe('entry')
    expect(flowNodeFamily('')).toBe('entry')
    expect(flowNodeFamily('start')).toBe('entry')
    expect(flowNodeFamily('entry')).toBe('entry')
  })

  it('maps control-flow kinds to operator', () => {
    expect(flowNodeFamily('human')).toBe('operator')
    expect(flowNodeFamily('parallel')).toBe('operator')
    expect(flowNodeFamily('done')).toBe('operator')
    expect(flowNodeFamily('gate')).toBe('operator')
    expect(flowNodeFamily('call')).toBe('operator')
  })

  it('maps work kinds to action', () => {
    expect(flowNodeFamily('agent')).toBe('action')
    expect(flowNodeFamily('run')).toBe('action')
  })
})
