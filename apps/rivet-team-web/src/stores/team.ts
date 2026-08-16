/**
 * rivet-team UI state: selected persona, one live thread, working chip.
 * Gateway I/O goes through TeamGateway (stub this slice).
 */

import { create } from 'zustand'
import { getGateway } from '../lib/gateway.js'
import { memoryCount } from '../lib/memory.js'
import type { Persona, Subscription, TeamMessage, WsStatus } from '../lib/types.js'
import { LOCAL_NODE_ID, LOCAL_USER_ID } from '../lib/types.js'
import type { TeamUser } from '../lib/users.js'

interface TeamState {
  userId: string
  userHandle: string
  userName: string
  personas: Persona[]
  selectedId: string | null
  messages: TeamMessage[]
  wsStatus: WsStatus
  working: boolean
  memoryNotes: number
  selectPersona: (id: string) => void
  send: (text: string) => Promise<void>
  refreshMemory: () => void
}

let sub: Subscription | undefined

function tag(persona: Persona, userId: string, msg: { id: string; sessionId: string; role: 'user' | 'assistant'; text: string; ts: number }): TeamMessage {
  return {
    ...msg,
    userId,
    personaId: persona.id,
    nodeId: persona.nodeId,
  }
}

export const useTeam = create<TeamState>((set, get) => ({
  userId: LOCAL_USER_ID,
  userHandle: 'local',
  userName: 'Local',
  personas: [],
  selectedId: null,
  messages: [],
  wsStatus: 'closed',
  working: false,
  memoryNotes: 0,

  refreshMemory() {
    set({ memoryNotes: memoryCount(get().userId) })
  },

  selectPersona(id: string) {
    const { personas, userId } = get()
    const persona = personas.find((p) => p.id === id)
    if (!persona) return
    sub?.close()
    set({ selectedId: id, messages: [], working: false, wsStatus: 'connecting' })
    const g = getGateway()
    void g.sessionMessages(persona.threadId).then((res) => {
      if (get().selectedId !== id) return
      set({
        messages: res.messages.map((m) => tag(persona, userId, m)),
      })
    })
    sub = g.watchSessions(
      (frame) => {
        if (get().selectedId !== id) return
        if (frame.kind === 'stream') {
          if (frame.event.type === 'status' && frame.event.metadata?.card === 'working') {
            set({ working: true })
          }
          if (frame.event.type === 'done' || frame.event.type === 'error') {
            set({ working: false })
          }
          return
        }
        if (frame.kind === 'message') {
          const next = tag(persona, userId, frame)
          set((s) => ({
            messages: s.messages.some((m) => m.id === next.id) ? s.messages : [...s.messages, next],
            working: frame.role === 'assistant' ? false : s.working,
          }))
          if (frame.role === 'assistant') get().refreshMemory()
        }
      },
      persona.threadId,
      { onStatus: (wsStatus) => set({ wsStatus }) },
    )
  },

  async send(text: string) {
    const { selectedId, personas, userId } = get()
    const persona = personas.find((p) => p.id === selectedId)
    if (!persona) return
    await getGateway().postMessage(persona.threadId, { text, userId, agent: persona.id })
  },
}))

export function bootTeam(user?: TeamUser): void {
  const userId = user?.id ?? LOCAL_USER_ID
  const g = getGateway()
  const personas = g.listPersonas(userId)
  useTeam.setState({
    userId,
    userHandle: user?.handle ?? 'local',
    userName: user?.displayName ?? 'Local',
    personas,
    memoryNotes: memoryCount(userId),
  })
  const first = personas[0]
  if (first) useTeam.getState().selectPersona(first.id)
}

export { LOCAL_NODE_ID }
