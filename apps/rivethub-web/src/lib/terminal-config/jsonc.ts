/**
 * JSON with comments and trailing commas — Windows Terminal's settings.json
 * ships with `//` comments in the stock file, so plain JSON.parse fails on a
 * config nobody has hand-cleaned.
 *
 * A scanner rather than a regex: `"https://…"` and `", }"` inside a string
 * value must not be mistaken for a comment or a trailing comma.
 */

import { MAX_PARSER_CHARS, oversizedWarning } from './common.js'

function copyQuotedString(text: string, start: number): { out: string; i: number } {
  let out = text[start] ?? ''
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    out += ch
    i++
    if (ch === '\\') {
      out += text[i] ?? ''
      i++
      continue
    }
    if (ch === '"') break
  }
  return { out, i }
}

/**
 * Strip line comments and block comments. Block comments become a single
 * space so adjacent tokens cannot fuse. An unclosed block comment throws
 * rather than returning truncated JSON.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const copied = copyQuotedString(text, i)
      out += copied.out
      i = copied.i
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      let closed = false
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') {
          i += 2
          closed = true
          break
        }
        i++
      }
      if (!closed) throw new Error('Unclosed block comment')
      out += ' '
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Drop a comma only when the next non-whitespace token is `}` or `]`.
 * String contents are copied verbatim so `", }"` inside a value survives.
 */
function stripTrailingCommas(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const copied = copyQuotedString(text, i)
      out += copied.out
      i = copied.i
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < text.length) {
        const n = text[j]
        if (n !== ' ' && n !== '\t' && n !== '\r' && n !== '\n') break
        j++
      }
      if (text[j] === '}' || text[j] === ']') {
        i++
        continue
      }
    }
    out += c
    i++
  }
  return out
}

export function parseJsonc(text: string): unknown {
  if (text.length > MAX_PARSER_CHARS) throw new Error(oversizedWarning('config'))
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)))
}
