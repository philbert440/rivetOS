/**
 * Pure per-session turn tracker: derive status / turn-complete / AskUserQuestion
 * edges from a full parsed transcript. The driver owns emit + timers.
 */

import {
  deriveTurnStatus,
  type HarnessAskOption,
  type HarnessAskQuestion,
  type HarnessTranscriptTurn,
} from '@rivetos/types'
import type { HarnessAdapter } from './adapters/types.js'

export interface TrackerEdges {
  status?: {
    status: 'working' | 'idle'
    phase?: 'thinking' | 'tool' | 'writing' | 'prompt'
    tool?: { name: string; toolCallId?: string }
    promptId?: string
  }
  turnCompleted?: true
  promptsOpened: Array<{ promptId: string; toolName: string; questions: HarnessAskQuestion[] }>
  promptsResolved: Array<{ promptId: string; answerText?: string }>
}

export interface TurnTracker {
  apply(turns: HarnessTranscriptTurn[], command: string): TrackerEdges
  inFlight(): boolean | undefined
  pendingPromptIds(): string[]
}

function labelFromOption(opt: unknown): string | undefined {
  if (typeof opt === 'string' && opt.trim()) return opt.trim()
  if (opt && typeof opt === 'object') {
    const o = opt as Record<string, unknown>
    if (typeof o.label === 'string' && o.label.trim()) return o.label.trim()
    if (typeof o.value === 'string' && o.value.trim()) return o.value.trim()
    if (typeof o.text === 'string' && o.text.trim()) return o.text.trim()
  }
  return undefined
}

function optionFrom(opt: unknown): HarnessAskOption | undefined {
  const label = labelFromOption(opt)
  if (!label) return undefined
  if (opt && typeof opt === 'object') {
    const d = (opt as Record<string, unknown>).description
    if (typeof d === 'string' && d.trim()) return { label, description: d.trim() }
  }
  return { label }
}

function optionsFromArray(arr: unknown): HarnessAskOption[] {
  if (!Array.isArray(arr)) return []
  const seen = new Set<string>()
  const out: HarnessAskOption[] = []
  for (const item of arr) {
    const o = optionFrom(item)
    if (!o || seen.has(o.label)) continue
    seen.add(o.label)
    out.push(o)
    if (out.length >= 20) break
  }
  return out
}

function questionFrom(q: unknown): HarnessAskQuestion | undefined {
  if (!q || typeof q !== 'object') return undefined
  const qo = q as Record<string, unknown>
  const options = [...optionsFromArray(qo.options), ...optionsFromArray(qo.choices)]
  if (options.length === 0) return undefined
  const question =
    typeof qo.question === 'string' && qo.question.trim() ? qo.question.trim() : undefined
  const header = typeof qo.header === 'string' && qo.header.trim() ? qo.header.trim() : undefined
  return { question, header, multiSelect: qo.multiSelect === true, options }
}

/**
 * Copy of web `extractAskUserQuestions` (do not import app code). Cap 4
 * questions / 20 options; skip malformed; dedupe labels.
 */
export function extractAskUserQuestions(args: unknown): HarnessAskQuestion[] {
  if (args == null) return []
  let root: unknown = args
  if (typeof args === 'string') {
    try {
      root = JSON.parse(args) as unknown
    } catch {
      return []
    }
  }
  if (typeof root !== 'object' || root === null) return []
  const obj = root as Record<string, unknown>
  if (Array.isArray(obj.questions)) {
    const nested = obj.questions
      .map(questionFrom)
      .filter((q): q is HarnessAskQuestion => q !== undefined)
    if (nested.length) return nested.slice(0, 4)
  }
  const flat = questionFrom(obj)
  if (flat) return [flat]
  if (obj.type === 'yes_no') {
    const question =
      typeof obj.question === 'string' && obj.question.trim() ? obj.question.trim() : undefined
    return [{ question, multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }]
  }
  return []
}

function statusSig(s: NonNullable<TrackerEdges['status']>): string {
  return JSON.stringify({
    status: s.status,
    phase: s.phase ?? null,
    tool: s.tool ?? null,
    promptId: s.promptId ?? null,
  })
}

export function createTurnTracker(adapter: HarnessAdapter): TurnTracker {
  const liveTurn = adapter.capabilities().liveTurn
  const promptNames = new Set(adapter.promptToolNames)
  // Unknown until the first frame is applied — before that the driver's own
  // claim/clock must decide, not a tracker that has never seen the store.
  let currentInFlight: boolean | undefined = undefined
  let lastStatus: TrackerEdges['status']
  let wasComplete = false
  let applied = false
  const pending = new Map<
    string,
    { toolName: string; questions: HarnessAskQuestion[]; resolved: boolean }
  >()

  return {
    apply(turns, command): TrackerEdges {
      const empty: TrackerEdges = { promptsOpened: [], promptsResolved: [] }
      if (!liveTurn) return empty

      const derived = deriveTurnStatus(turns, command)
      let inFlight: boolean
      if (derived.inFlight === true) inFlight = true
      else if (derived.inFlight === false) inFlight = false
      else {
        const last = turns[turns.length - 1]
        // No turns at all → nothing in flight (an un-echoed explicit claim is
        // the driver's business, not the tracker's).
        inFlight = last !== undefined && (last.role === 'user' || last.complete !== true)
      }
      currentInFlight = inFlight

      const nextStatus: NonNullable<TrackerEdges['status']> = {
        status: inFlight ? 'working' : 'idle',
      }
      if (derived.phase) nextStatus.phase = derived.phase
      if (derived.tool) nextStatus.tool = derived.tool
      if (derived.promptToolId) nextStatus.promptId = derived.promptToolId

      const edges: TrackerEdges = { promptsOpened: [], promptsResolved: [] }
      if (!lastStatus || statusSig(lastStatus) !== statusSig(nextStatus)) {
        edges.status = nextStatus
      }
      lastStatus = nextStatus

      const last = turns[turns.length - 1]
      const nowComplete = last?.role === 'assistant' && last.complete === true
      if (applied && nowComplete && !wasComplete) edges.turnCompleted = true
      wasComplete = nowComplete
      applied = true

      const tools = last?.role === 'assistant' ? (last.tools ?? []) : []
      for (const tool of tools) {
        if (!tool.id || !promptNames.has(tool.name)) continue
        const questions = extractAskUserQuestions(tool.input)
        if (!questions.length) continue
        const resolved =
          tool.status === 'done' || tool.status === 'error' || Boolean(tool.resultText)
        const prev = pending.get(tool.id)
        if (!prev) {
          pending.set(tool.id, { toolName: tool.name, questions, resolved })
          if (!resolved) {
            edges.promptsOpened.push({ promptId: tool.id, toolName: tool.name, questions })
          }
        } else if (!prev.resolved && resolved) {
          prev.resolved = true
          edges.promptsResolved.push({
            promptId: tool.id,
            ...(tool.resultText ? { answerText: tool.resultText } : {}),
          })
        }
      }

      return edges
    },
    inFlight: () => currentInFlight,
    pendingPromptIds: () => [...pending.entries()].filter(([, v]) => !v.resolved).map(([id]) => id),
  }
}
