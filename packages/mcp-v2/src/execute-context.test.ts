import { describe, expect, it } from 'vitest'
import { extractExecuteContext } from './server.js'

describe('extractExecuteContext', () => {
  it('copies mcpReq.signal and lets a top-level signal win', () => {
    const nested = new AbortController().signal
    const top = new AbortController().signal
    expect(extractExecuteContext({ mcpReq: { signal: nested } }).signal).toBe(nested)
    expect(extractExecuteContext({ signal: top, mcpReq: { signal: nested } }).signal).toBe(top)
    expect(extractExecuteContext({ mcpReq: { signal: 'nope' } }).signal).toBeUndefined()
    expect(extractExecuteContext({ mcpReq: { inputResponses: { confirm: true } } })).toEqual({
      inputResponses: { confirm: true },
    })
  })
})
