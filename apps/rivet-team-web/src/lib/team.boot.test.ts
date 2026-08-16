import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetMemory, appendMemory } from './memory.js'
import { createStubGateway } from './stub-gateway.js'
import { createLocalUser, resetLocalUsers } from './users.js'
import { setGateway } from './gateway.js'
import { bootTeam, useTeam } from '../stores/team.js'

describe('bootTeam user switch', () => {
  beforeEach(() => {
    setGateway(createStubGateway())
  })

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

  it('does not carry phil memory onto alex after switch', async () => {
    const phil = createLocalUser('phil', 'Phil')
    const alex = createLocalUser('alex', 'Alex')
    appendMemory({ userId: phil.id, content: 'phil secret', role: 'user', agent: 'p' })
    await bootTeam(phil)
    expect(useTeam.getState().userId).toBe(phil.id)
    expect(useTeam.getState().memoryNotes).toBe(1)
    expect(useTeam.getState().live).toBe(false)

    await bootTeam(alex)
    expect(useTeam.getState().userId).toBe(alex.id)
    expect(useTeam.getState().memoryNotes).toBe(0)
    expect(useTeam.getState().messages).toEqual([])
    expect(useTeam.getState().userHandle).toBe('alex')
  })
})
