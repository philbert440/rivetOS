import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentFilter } from './agent-filter.js'

describe('useAgentFilter', () => {
  beforeEach(() => useAgentFilter.getState().clear())

  it('selects an agent with its fresh-session action', () => {
    const startNew = vi.fn()
    useAgentFilter
      .getState()
      .select({ agentId: 'a1', name: 'Claude Code', accent: '#CC785C', startNew })
    const s = useAgentFilter.getState()
    expect(s.agentId).toBe('a1')
    expect(s.name).toBe('Claude Code')
    s.startNew?.()
    expect(startNew).toHaveBeenCalledOnce()
  })

  it('clears back to every conversation', () => {
    useAgentFilter
      .getState()
      .select({ agentId: 'a1', name: 'x', accent: '#000', startNew: () => undefined })
    useAgentFilter.getState().clear()
    const s = useAgentFilter.getState()
    expect(s.agentId).toBeUndefined()
    expect(s.startNew).toBeUndefined()
  })
})
