import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStubGateway } from './lib/stub-gateway.js'
import { setGateway } from './lib/gateway.js'
import { resetMemory } from './lib/memory.js'
import { resetLocalUsers } from './lib/users.js'
import { bootTeam, useTeam } from './stores/team.js'
import { api, sendOnTeamGateway } from './omb/state/store.js'

describe('OpenMausBot UI → rivet-team gateway wire', () => {
  afterEach(() => {
    resetLocalUsers()
    resetMemory()
    useTeam.setState({
      userId: 'local-user',
      userHandle: 'local',
      userName: 'Local',
      deviceToken: null,
      live: false,
      personas: [],
      selectedId: null,
      messages: [],
      memoryNotes: 0,
      lastError: null,
    })
  })

  it('sendOnTeamGateway posts on the team stub, not fetch(/api/bots)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const g = createStubGateway()
    setGateway(g)
    await bootTeam()
    const persona = g.listPersonas(useTeam.getState().userId)[0]
    expect(persona).toBeTruthy()

    const frames: string[] = []
    const sub = g.watchSessions((frame) => {
      if (frame.kind === 'message') frames.push(`${frame.role}:${frame.text}`)
    }, persona.threadId)

    await sendOnTeamGateway(persona.id, 'hello from roster')
    await vi.waitFor(() => {
      expect(frames.some((f) => f.startsWith('user:'))).toBe(true)
      expect(frames.some((f) => f.startsWith('assistant:'))).toBe(true)
    })
    expect(frames.find((f) => f.startsWith('user:'))).toContain('hello from roster')
    expect(fetchSpy).not.toHaveBeenCalled()
    sub.close()
    fetchSpy.mockRestore()
  })

  it('api() refuses OpenMausBot harness chat paths', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(api('/api/bots/x/messages', { method: 'POST', body: '{}' })).rejects.toThrow(
      /team gateway/,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
