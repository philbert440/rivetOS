/**
 * rivet-team UI state: selected persona, one live thread, working chip.
 * Turns stay on the stub. Personas/notes use /api/team when paired.
 */

import { create } from 'zustand'
import { getGateway } from '../lib/gateway.js'
import { appendMemory, memoryCount } from '../lib/memory.js'
import { liveCreateNote, livePersonas, liveSearchNotes } from '../lib/live-team.js'
import type { Persona, Subscription, TeamMessage, WsStatus } from '../lib/types.js'
import { LOCAL_NODE_ID, LOCAL_USER_ID } from '../lib/types.js'
import type { TeamUser } from '../lib/users.js'

export interface MessagePreview {
  text: string
  ts: number
}

interface TeamState {
  userId: string
  userHandle: string
  userName: string
  deviceToken: string | null
  live: boolean
  personas: Persona[]
  selectedId: string | null
  messages: TeamMessage[]
  previews: Record<string, MessagePreview>
  wsStatus: WsStatus
  working: boolean
  memoryNotes: number
  lastError: string | null
  selectPersona: (id: string | null) => void
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

async function persistNote(
  token: string | null,
  userId: string,
  persona: Persona,
  role: string,
  content: string,
): Promise<void> {
  if (token) {
    await liveCreateNote(token, { personaId: persona.id, role, content })
    return
  }
  appendMemory({ userId, content, role, agent: persona.id })
}

async function hydratePreviews(personas: Persona[]): Promise<Record<string, MessagePreview>> {
  const g = getGateway()
  const entries = await Promise.all(
    personas.map(async (p) => {
      const res = await g.sessionMessages(p.threadId)
      const last = res.messages.at(-1)
      return last ? ([p.id, { text: last.text, ts: last.ts }] as const) : null
    }),
  )
  const previews: Record<string, MessagePreview> = {}
  for (const e of entries) {
    if (e) previews[e[0]] = e[1]
  }
  return previews
}

export const useTeam = create<TeamState>((set, get) => ({
  userId: LOCAL_USER_ID,
  userHandle: 'local',
  userName: 'Local',
  deviceToken: null,
  live: false,
  personas: [],
  selectedId: null,
  messages: [],
  previews: {},
  wsStatus: 'closed',
  working: false,
  memoryNotes: 0,
  lastError: null,

  refreshMemory() {
    const { deviceToken, userId } = get()
    if (deviceToken) {
      void liveSearchNotes(deviceToken, '').then((notes) => {
        if (get().userId === userId) set({ memoryNotes: notes.length })
      }).catch(() => {
        set({ memoryNotes: memoryCount(userId) })
      })
      return
    }
    set({ memoryNotes: memoryCount(userId) })
  },

  selectPersona(id: string | null) {
    if (id === null) {
      sub?.close()
      sub = undefined
      set({ selectedId: null, messages: [], working: false, wsStatus: 'closed' })
      return
    }
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
            previews: {
              ...s.previews,
              [persona.id]: { text: next.text, ts: next.ts },
            },
          }))
          if (frame.role === 'assistant') {
            void persistNote(get().deviceToken, userId, persona, 'assistant', frame.text)
              .then(() => {
                useTeam.setState({ lastError: null })
                get().refreshMemory()
              })
              .catch((err: Error) => {
                useTeam.setState({ lastError: err.message })
              })
          }
        }
      },
      persona.threadId,
      { onStatus: (wsStatus) => set({ wsStatus }) },
    )
  },

  async send(text: string) {
    const { selectedId, personas, userId, deviceToken } = get()
    const persona = personas.find((p) => p.id === selectedId)
    if (!persona) return
    try {
      await persistNote(deviceToken, userId, persona, 'user', text)
      set({ lastError: null })
    } catch (err) {
      set({ lastError: (err as Error).message })
      return
    }
    await getGateway().postMessage(persona.threadId, { text, userId, agent: persona.id })
    get().refreshMemory()
  },
}))

export async function bootTeam(user?: TeamUser, deviceToken?: string): Promise<void> {
  const userId = user?.id ?? LOCAL_USER_ID
  let personas = getGateway().listPersonas(userId)
  let live = false
  if (deviceToken) {
    try {
      personas = await livePersonas(deviceToken)
      live = true
    } catch {
      live = false
    }
  }
  const previews = await hydratePreviews(personas)
  useTeam.setState({
    userId,
    userHandle: user?.handle ?? 'local',
    userName: user?.displayName ?? 'Local',
    deviceToken: deviceToken ?? null,
    live,
    personas,
    selectedId: null,
    messages: [],
    working: false,
    previews,
    memoryNotes: 0,
    lastError: null,
  })
  useTeam.getState().refreshMemory()
}

export { LOCAL_NODE_ID }
