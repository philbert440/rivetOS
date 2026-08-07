import { describe, it, expect } from 'vitest'
import { languageForPath } from './editor-lang.js'

describe('languageForPath', () => {
  it('picks by extension', () => {
    expect(languageForPath('workflow.yaml')).toBe('yaml')
    expect(languageForPath('agents/x.md')).toBe('markdown')
    expect(languageForPath('run.ts')).toBe('typescript')
    expect(languageForPath('lib/util.js')).toBe('javascript')
    expect(languageForPath('config.yml')).toBe('yaml')
    expect(languageForPath('pkg.json')).toBe('json')
    expect(languageForPath('Makefile')).toBe('plain')
    expect(languageForPath('notes.TXT')).toBe('plain')
  })
})
