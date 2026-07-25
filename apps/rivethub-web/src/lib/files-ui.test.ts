import { describe, it, expect } from 'vitest'
import { baseName, joinRel, parentRel, previewKind } from './files-ui.js'

describe('joinRel / parentRel / baseName', () => {
  it('joins and splits paths', () => {
    expect(joinRel('', 'a.txt')).toBe('a.txt')
    expect(joinRel('plans', 'a.txt')).toBe('plans/a.txt')
    expect(parentRel('plans/a.txt')).toBe('plans')
    expect(parentRel('a.txt')).toBe('')
    expect(baseName('plans/a.txt')).toBe('a.txt')
  })
})

describe('previewKind', () => {
  it('classifies text and images under size caps', () => {
    expect(previewKind('notes.md', 100)).toBe('text')
    expect(previewKind('pic.png', 1000)).toBe('image')
    expect(previewKind('big.md', 2 * 1024 * 1024)).toBe('none')
    expect(previewKind('bin.dat', 10)).toBe('none')
  })
})
