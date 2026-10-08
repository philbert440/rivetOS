import { describe, expect, it } from 'vitest'
import { arrivalJump, scrollToEnd, type TranscriptEdge } from './transcript-follow.js'

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

describe('scrollToEnd', () => {
  it('moves only the given scroll box to its bottom', () => {
    const el = { scrollTop: 0, scrollHeight: 1200 }
    scrollToEnd(el)
    expect(el.scrollTop).toBe(1200)
  })
})

describe('transcript follow', () => {
  it('never calls scrollIntoView, which also scrolls canvas ancestors', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(new URL('../components/transcript.tsx', import.meta.url), 'utf8')
    expect(src).not.toContain('scrollIntoView')
  })
})
