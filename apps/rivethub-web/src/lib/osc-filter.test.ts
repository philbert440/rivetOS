import { describe, expect, it } from 'vitest'
import { isOscColorReport, stripOscColorQueries } from './osc-filter.js'

function bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function str(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!)
  return s
}

describe('stripOscColorQueries', () => {
  it('removes OSC 11 background query (BEL-terminated)', () => {
    const raw = 'hello\x1b]11;?\x07world'
    expect(str(stripOscColorQueries(bytes(raw)))).toBe('helloworld')
  })

  it('removes OSC 10/11/12 with ST terminator', () => {
    const raw = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\'
    expect(str(stripOscColorQueries(bytes(raw)))).toBe('')
  })

  it('leaves normal output alone', () => {
    const raw = 'plain text\r\n$ '
    const b = bytes(raw)
    expect(stripOscColorQueries(b)).toBe(b)
  })

  it('does not strip color *set* sequences (non-query)', () => {
    const raw = '\x1b]11;rgb:0d0d/1111/1717\x07'
    expect(str(stripOscColorQueries(bytes(raw)))).toBe(raw)
  })
})

describe('isOscColorReport', () => {
  it('detects full and ESC-stripped reports', () => {
    expect(isOscColorReport('\x1b]11;rgb:0d0d/1111/1717\x07')).toBe(true)
    expect(isOscColorReport(']11;rgb:0d0d/1111/1717')).toBe(true)
    expect(isOscColorReport('hello')).toBe(false)
  })
})
