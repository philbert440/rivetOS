import { describe, it, expect } from 'vitest'
import { markdownToTelegramHtml } from './format.js'

describe('markdownToTelegramHtml', () => {
  it('returns empty string for empty input', () => {
    expect(markdownToTelegramHtml('')).toBe('')
  })

  it('escapes HTML metacharacters in plain text', () => {
    const out = markdownToTelegramHtml('a < b && c > d')
    expect(out).toBe('a &lt; b &amp;&amp; c &gt; d')
  })

  it('renders bold and italic', () => {
    expect(markdownToTelegramHtml('**bold** and *italic*')).toBe('<b>bold</b> and <i>italic</i>')
  })

  it('renders inline code', () => {
    expect(markdownToTelegramHtml('run `npm test` now')).toBe('run <code>npm test</code> now')
  })

  it('renders fenced code blocks and escapes HTML inside them', () => {
    const md = '```ts\nconst x = a < b\n```'
    const out = markdownToTelegramHtml(md)
    expect(out).toBe('<pre><code class="language-ts">const x = a &lt; b</code></pre>')
  })

  it('renders fenced code blocks without language', () => {
    expect(markdownToTelegramHtml('```\nplain\n```')).toBe('<pre>plain</pre>')
  })

  it('renders markdown links', () => {
    expect(markdownToTelegramHtml('see [docs](https://rivetos.dev)')).toBe(
      'see <a href="https://rivetos.dev">docs</a>',
    )
  })

  it('converts unordered list markers to bullets', () => {
    expect(markdownToTelegramHtml('- one\n- two')).toBe('• one\n• two')
  })

  it('converts headings to bold lines', () => {
    expect(markdownToTelegramHtml('# Title')).toBe('<b>Title</b>')
  })

  it('does not corrupt mid-word underscores', () => {
    expect(markdownToTelegramHtml('snake_case_name')).toBe('snake_case_name')
  })
})
