import { describe, expect, it } from 'vitest'
import { AGENT_DRAG_MIME, isAgentDrag } from './agent-drag.js'

describe('isAgentDrag', () => {
  it('is true when the drag carries the agent payload', () => {
    expect(isAgentDrag(['text/plain', AGENT_DRAG_MIME])).toBe(true)
  })

  it('is false for a plain text or file drag', () => {
    expect(isAgentDrag(['text/plain'])).toBe(false)
    expect(isAgentDrag(['Files'])).toBe(false)
    expect(isAgentDrag([])).toBe(false)
  })
})
