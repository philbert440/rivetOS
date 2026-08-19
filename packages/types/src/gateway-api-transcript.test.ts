import { describe, expect, it } from 'vitest'
import { mergeTranscriptWindow } from './gateway-api.js'

describe('mergeTranscriptWindow', () => {
  it('returns next as-is when the parse was not truncated', () => {
    expect(mergeTranscriptWindow(['a', 'b', 'c'], ['b', 'c'], false)).toEqual(['b', 'c'])
  })

  it('returns next when there is nothing to pin', () => {
    expect(mergeTranscriptWindow([], ['c', 'd'], true)).toEqual(['c', 'd'])
    expect(mergeTranscriptWindow(['a', 'b'], [], true)).toEqual([])
  })

  it('pins the prefix that slid out of the tail window', () => {
    expect(mergeTranscriptWindow(['a', 'b', 'c', 'd', 'e'], ['c', 'd', 'e', 'f'], true)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ])
  })

  it('keeps an already-pinned prefix across a second window slide', () => {
    const pinned = mergeTranscriptWindow(['a', 'b', 'c', 'd'], ['b', 'c', 'd', 'e'], true)
    expect(pinned).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(mergeTranscriptWindow(pinned, ['c', 'd', 'e', 'f'], true)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ])
  })

  it('does not pin on a coincidental first-element match with a broken overlap', () => {
    expect(mergeTranscriptWindow(['x', 'y', 'z'], ['x', 'nope'], true)).toEqual(['x', 'nope'])
  })

  it('falls through to next when the window jumped past the held prefix', () => {
    expect(mergeTranscriptWindow(['a', 'b', 'c'], ['m', 'n'], true)).toEqual(['m', 'n'])
  })
})
