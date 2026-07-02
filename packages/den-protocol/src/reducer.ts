// Pure room-state reducer: feed AgentEvents in, get RoomState out.
// Renderer-agnostic — no PixiJS, no DOM, no timers.

import { type Activity, type AgentEvent, toolActivity } from './events.js'

export interface Task {
  label: string
  done: boolean
}

export interface LogEntry {
  who: 'user' | 'agent'
  text: string
}

export interface RoomState {
  title: string
  activity: Activity
  /** Raw tool name while a tool runs, else null. Packs use this for
   *  per-tool pose overrides (fallback: activity, then 'idle'). */
  tool: string | null
  tasks: Task[]
  thought: string // streamed thinking text ('' = no bubble)
  lastMessage: string
  log: LogEntry[] // conversation transcript for the narration panel
  term: string[] // terminal lines shown on the desk monitor
  ended: boolean
}

export const initialRoomState: RoomState = {
  title: '',
  activity: 'idle',
  tool: null,
  tasks: [],
  thought: '',
  lastMessage: '',
  log: [],
  term: [],
  ended: false,
}

const THOUGHT_MAX = 220
const LOG_MAX = 12
const TERM_MAX = 6

export function reduceRoom(state: RoomState, ev: AgentEvent): RoomState {
  switch (ev.type) {
    case 'session.start':
      // the conversation log survives session boundaries (compaction, resume)
      return { ...initialRoomState, title: ev.title, log: state.log }
    case 'session.end':
      return { ...state, activity: 'sleeping', tool: null, thought: '', ended: true }
    case 'task.plan':
      return {
        ...state,
        tasks: ev.tasks.map((label) => ({ label, done: false })),
        activity: 'writing_plan',
      }
    case 'task.check': {
      const tasks = state.tasks.map((t, i) => (i === ev.index ? { ...t, done: true } : t))
      return { ...state, tasks }
    }
    case 'activity':
      return {
        ...state,
        activity: ev.activity,
        tool: null,
        thought: ev.activity === 'thinking' ? state.thought : '',
      }
    case 'tool.start':
      return {
        ...state,
        tool: ev.tool,
        activity: ev.activity ?? toolActivity(ev.tool),
        thought: '',
      }
    case 'tool.end':
      return { ...state, tool: null, activity: 'thinking' }
    case 'thinking.delta': {
      let thought = (state.thought + ev.text).slice(-THOUGHT_MAX)
      // when the window is full, trim to a word boundary so the stream never
      // opens mid-word
      if (thought.length === THOUGHT_MAX) thought = thought.replace(/^\S*\s+/, '')
      return { ...state, activity: 'thinking', tool: null, thought }
    }
    case 'thinking.end':
      return { ...state, thought: '' }
    case 'speech.stt':
      return ev.active
        ? { ...state, activity: 'listening', tool: null, thought: '' }
        : { ...state, activity: 'thinking' }
    case 'message.user':
      return {
        ...state,
        log: [...state.log, { who: 'user' as const, text: ev.text }].slice(-LOG_MAX),
      }
    case 'message.agent':
      return {
        ...state,
        lastMessage: ev.text,
        activity: 'speaking',
        tool: null,
        thought: '',
        log: [...state.log, { who: 'agent' as const, text: ev.text }].slice(-LOG_MAX),
      }
    case 'term.line':
      return { ...state, term: [...state.term, ev.text].slice(-TERM_MAX) }
  }
}

// ---------------------------------------------------------------------------
// Multi-session: one room per session id.

export interface SessionInfo {
  id: string
  /** Display name — last non-empty `name` seen on the wire, else the id. */
  name: string
  harness?: string
  /** ts of the most recent event, when events carry timestamps. */
  lastEventTs?: number
}

export interface DenState {
  rooms: Record<string, RoomState>
  sessions: Record<string, SessionInfo>
}

export const initialDenState: DenState = { rooms: {}, sessions: {} }

export function reduceDen(state: DenState, ev: AgentEvent): DenState {
  const room = state.rooms[ev.session] ?? initialRoomState
  const prev = (state.sessions as Partial<Record<string, SessionInfo>>)[ev.session]
  const info: SessionInfo = {
    id: ev.session,
    name: ev.name || prev?.name || ev.session,
    harness: ev.harness ?? prev?.harness,
    lastEventTs: ev.ts ?? prev?.lastEventTs,
  }
  return {
    rooms: { ...state.rooms, [ev.session]: reduceRoom(room, ev) },
    sessions: { ...state.sessions, [ev.session]: info },
  }
}

/** Session list ordered by recency (most recent event first, unknown last). */
export function listSessions(state: DenState): SessionInfo[] {
  return Object.values(state.sessions).sort((a, b) => (b.lastEventTs ?? 0) - (a.lastEventTs ?? 0))
}
