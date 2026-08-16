/**
 * In-process stub of the Rivet gateway session + memory surface.
 *
 * Same method names as RivetGateway. Replies are local so a reviewer can
 * send a message and see a working chip, then an assistant turn, without
 * a live node. Swap for `new RivetGateway({ baseUrl })` in a later slice.
 */

import type { TeamGateway } from './gateway.js'
import { appendMemory, searchMemory } from './memory.js'
import { personaByThread, SAMPLE_PERSONAS } from './seed.js'
import type {
  GatewayClientConfig,
  MemorySearchResponse,
  Persona,
  SessionMessage,
  SessionMessagesResponse,
  SessionPostAccepted,
  SessionPostRequest,
  SessionsListResponse,
  SessionWsFrame,
  Subscription,
  WatchOptions,
} from './types.js'
import { LOCAL_USER_ID } from './types.js'
import { uuidv4 } from './uuid.js'

interface Watcher {
  sessionId?: string
  onFrame: (frame: SessionWsFrame) => void
}

const threads = new Map<string, SessionMessage[]>()
const watchers = new Set<Watcher>()

function emit(frame: SessionWsFrame): void {
  const session = frame.kind === "message" ? frame.sessionId : frame.kind === "stream" ? frame.session : undefined
  for (const w of watchers) {
    if (w.sessionId && w.sessionId !== session) continue
    w.onFrame(frame)
  }
}

function stubReply(personaName: string, userText: string): string {
  const clipped = userText.trim().replace(/\s+/g, ' ').slice(0, 220)
  if (personaName === 'Summarizer') {
    return `Brief: ${clipped || '(empty)'}\n\n• Point taken.\n• Next: I would tighten this against source material once the live gateway is wired.`
  }
  if (personaName === 'Informatics') {
    return `facts:\n- input: "${clipped || ''}"\n- status: captured (stub)\n- next: persist via /api/sessions when the real RivetGateway is bound`
  }
  return `I would look into “${clipped || 'that'}”. This slice is the stub gateway — same postMessage / watchSessions contract as Hub, no live model yet.`
}

export function createStubGateway(config: GatewayClientConfig = { baseUrl: 'http://127.0.0.1:5174' }): TeamGateway {
  return {
    config,

    async listSessions(): Promise<SessionsListResponse> {
      return {
        sessions: SAMPLE_PERSONAS.map((p) => {
          const msgs = threads.get(p.threadId) ?? []
          return {
            id: p.threadId,
            lastActive: msgs.at(-1)?.ts ?? 0,
            messages: msgs.length,
          }
        }),
      }
    },

    async sessionMessages(sessionId: string): Promise<SessionMessagesResponse> {
      return { messages: [...(threads.get(sessionId) ?? [])] }
    },

    async postMessage(sessionId: string, body: SessionPostRequest): Promise<SessionPostAccepted> {
      const persona = personaByThread(sessionId)
      const userId = body.userId ?? LOCAL_USER_ID
      const userMsg: SessionMessage = {
        id: uuidv4(),
        sessionId,
        role: 'user',
        text: body.text,
        ts: Date.now(),
      }
      const list = threads.get(sessionId) ?? []
      list.push(userMsg)
      threads.set(sessionId, list)
      emit({ kind: 'message', ...userMsg })
      emit({
        kind: 'stream',
        session: sessionId,
        event: { type: 'status', content: 'working', metadata: { card: 'working' } },
      })

      const delay = 450
      setTimeout(() => {
        const reply: SessionMessage = {
          id: uuidv4(),
          sessionId,
          role: 'assistant',
          text: stubReply(persona?.name ?? 'Persona', body.text),
          ts: Date.now(),
        }
        const next = threads.get(sessionId) ?? []
        next.push(reply)
        threads.set(sessionId, next)
        emit({
          kind: 'stream',
          session: sessionId,
          event: { type: 'done', content: '' },
        })
        emit({ kind: 'message', ...reply })
        appendMemory({
          userId,
          content: `${persona?.name ?? 'persona'}: ${body.text.slice(0, 160)}`,
          role: 'user',
          agent: persona?.id ?? sessionId,
        })
      }, delay)

      return { accepted: true, session: sessionId }
    },

    watchSessions(onFrame, sessionId, opts: WatchOptions = {}): Subscription {
      const watcher: Watcher = { sessionId, onFrame }
      watchers.add(watcher)
      opts.onStatus?.('connecting')
      queueMicrotask(() => opts.onStatus?.('open'))
      return {
        close() {
          watchers.delete(watcher)
          opts.onStatus?.('closed')
        },
        send() {
          return true
        },
      }
    },

    async memorySearch(query): Promise<MemorySearchResponse> {
      return searchMemory(LOCAL_USER_ID, query)
    },

    async health(): Promise<boolean> {
      return true
    },

    listPersonas(_userId: string): Persona[] {
      return SAMPLE_PERSONAS
    },
  }
}
