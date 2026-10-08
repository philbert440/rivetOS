/**
 * New-thread chooser decisions. The dialog and the History pick mode call
 * these; they are the only writers, so cancel is the absence of a write.
 *
 * A chosen roster agent mints the way the rail's start-over does (`openFresh`):
 * chat settings, node binding, agent pin, draft, on that agent's node.
 * Plain draft is a hub draft — it does not call the rail filter's `startNew`.
 * An agent with no roster node is refused, same as the rail. The first turn
 * is one `enqueueOutbound` — the composer's queue, not a second send path.
 */

import type { HarnessId, ThinkingLevel } from '@rivetos/types'
import { agentThreadSettings } from '../../lib/agent-roster.js'
import { setAgentLastSession } from '../../lib/agent-session.js'
import { setSessionNodeBinding } from '../../lib/session-node.js'
import { uuidv4 } from '../../lib/uuid.js'
import { useChat } from '../../stores/chat.js'
import { useChatSettings, type ChatSettings } from '../../stores/chat-settings.js'
import { useSpaces } from '../../stores/spaces.js'

export interface PromptAgent {
  id: string
  harnessId?: HarnessId
  model?: string
  effort?: string
  systemPrompt?: string
  sourceNodeBaseUrl?: string
}

export type ChooserAction =
  | { type: 'cancel' }
  | {
      type: 'prompt'
      prompt: string
      spaceId: string
      baseUrl: string
      agent?: PromptAgent
      model?: string
      effort?: ThinkingLevel
    }
  | {
      type: 'history'
      rowKey: string
      spaceId: string
      sessionId: string
      open: (sessionId: string) => void
    }

function spaceExists(spaceId: string): boolean {
  return useSpaces.getState().spaces.some((space) => space.id === spaceId)
}

function mintWithAgent(agent: PromptAgent, baseUrl: string): string | undefined {
  const nodeUrl = agent.sourceNodeBaseUrl
  if (!nodeUrl) return undefined
  const id = uuidv4()
  setSessionNodeBinding(id, nodeUrl, baseUrl)
  setAgentLastSession(agent.id, id, nodeUrl, { replace: true })
  useChat.getState().addDraft(id)
  useChat.getState().setActive(id)
  return id
}

/** Hub draft. Does not consult the rail's selected agent. */
function mintPlainDraft(): string {
  const id = uuidv4()
  const chat = useChat.getState()
  chat.addDraft(id)
  chat.setActive(id)
  return id
}

function settingsKeyFor(id: string, agent: PromptAgent | undefined, baseUrl: string): string {
  const node = agent?.sourceNodeBaseUrl
  return `${node && node.length > 0 ? node : baseUrl}::${id}`
}

function writeSettings(
  key: string,
  agent: PromptAgent | undefined,
  model: string | undefined,
  effort: ThinkingLevel | undefined,
): void {
  const base: Partial<ChatSettings> = agent
    ? agentThreadSettings({
        id: agent.id,
        harnessId: agent.harnessId,
        model: agent.model ?? '',
        effort: agent.effort ?? '',
        systemPrompt: agent.systemPrompt ?? '',
      })
    : { agent: '', effort: effort ?? 'medium' }
  if (model !== undefined) base.model = model
  if (effort !== undefined) {
    base.effort = effort
    base.harnessEffort = effort
  }
  useChatSettings.getState().set(key, base)
}

/** Returns the new session id, the picked session id, or undefined on cancel / refusal. */
export function applyChooser(action: ChooserAction): string | undefined {
  if (action.type === 'cancel') return undefined
  if (!spaceExists(action.spaceId)) return undefined
  if (action.type === 'history') {
    useSpaces.getState().place(action.rowKey, action.spaceId)
    if (useSpaces.getState().spaceOf(action.rowKey) !== action.spaceId) return undefined
    action.open(action.sessionId)
    return action.sessionId
  }
  const text = action.prompt.trim()
  if (!text) return undefined
  // Off-roster: the rail refuses to mint. Do not fall through to a hub draft
  // that still wears the agent's settings.
  if (action.agent && !action.agent.sourceNodeBaseUrl) return undefined
  const id = action.agent ? mintWithAgent(action.agent, action.baseUrl) : mintPlainDraft()
  if (!id) return undefined
  const key = settingsKeyFor(id, action.agent, action.baseUrl)
  writeSettings(key, action.agent, action.model, action.effort)
  useSpaces.getState().place(key, action.spaceId)
  useChat.getState().enqueueOutbound(id, text)
  return id
}
