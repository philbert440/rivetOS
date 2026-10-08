import { describe, expect, it } from 'vitest'
import { arrivalJump, type TranscriptEdge } from './transcript-follow.js'

const idle: TranscriptEdge = { lastId: 'm1', live: false, reasoning: false }

describe('arrivalJump', () => {
  it('jumps when a new message lands at the end', () => {
    expect(arrivalJump(idle, { ...idle, lastId: 'm2' })).toBe(true)
  })

  it('jumps when a turn finishes', () => {
    expect(arrivalJump({ ...idle, live: true }, idle)).toBe(true)
  })

  it('jumps when the agent is done thinking and starts writing', () => {
    expect(
      arrivalJump(
        { ...idle, live: true, reasoning: true },
        { ...idle, live: true, reasoning: false },
      ),
    ).toBe(true)
  })

  it('stays put mid-stream and when nothing new arrived', () => {
    expect(arrivalJump(idle, idle)).toBe(false)
    expect(arrivalJump({ ...idle, live: true }, { ...idle, live: true })).toBe(false)
    expect(arrivalJump(idle, { ...idle, live: true, reasoning: true })).toBe(false)
  })

  it('does not jump when history empties or loads nothing new at the end', () => {
    expect(arrivalJump(idle, { ...idle, lastId: undefined })).toBe(false)
  })
})
