import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { languageLabel, textFromMarkdownChildren } from './markdown.js'

describe('textFromMarkdownChildren', () => {
  it('flattens nested code element children to the fenced source', () => {
    // Mirrors react-markdown's pre > code structure for ```ts fences
    const tree = createElement(
      'code',
      { className: 'language-ts' },
      'const x = 1\n',
      'console.log(x)\n',
    )
    expect(textFromMarkdownChildren(tree)).toBe('const x = 1\nconsole.log(x)\n')
  })

  it('handles plain strings and arrays', () => {
    expect(textFromMarkdownChildren('hello')).toBe('hello')
    expect(textFromMarkdownChildren(['a', 'b'])).toBe('ab')
    expect(textFromMarkdownChildren(null)).toBe('')
  })
})

describe('languageLabel', () => {
  it('reads language-* from className', () => {
    expect(languageLabel('language-typescript')).toBe('typescript')
    expect(languageLabel('language-bash')).toBe('bash')
    expect(languageLabel(undefined)).toBe('code')
    expect(languageLabel('')).toBe('code')
  })
})
