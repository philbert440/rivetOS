/**
 * New-thread chooser decisions. The dialog and the History pick mode call
 * these; they are the only writers for that path, so cancel is the absence
 * of a write.
 *
 * A chosen roster agent mints the way the rail's start-over does (`openFresh`):
 * chat settings, node binding, agent pin, draft, on that agent's node.
 * Plain draft is a hub draft — it does not call the rail filter's `startNew`.
 * An agent with no roster node is refused, same as the rail. The first turn
 * is one `enqueueOutbound` — the composer's queue, not a second send path.
 *
 * Space defaults pre-fill that same path. `startThreadInSpace` is the
 * non-dialog mint (Ctrl+T while the canvas is focused on a space): a draft
 * like `startNewConversation`, placed here, with the space's settings. It
 * does not call the rail.
 */

import type { HarnessId, ThinkingLevel } from '@rivetos/types'
import { agentThreadSettings } from '../../lib/agent-roster.js'
import { setAgentLastSession } from '../../lib/agent-session.js'
import { setSessionNodeBinding } from '../../lib/session-node.js'
import { uuidv4 } from '../../lib/uuid.js'
import { useChat } from '../../stores/chat.js'
import { useChatSettings, type ChatSettings } from '../../stores/chat-settings.js'
import { useSpaces, type SpaceDefaults } from '../../stores/spaces.js'
import { startablePreset } from './space-defaults.js'

export interface PromptAgent {
  id: string
  harnessId?: HarnessId
  model?: string
  effort?: string
  systemPrompt?: string
  sourceNodeBaseUrl?: string
}

/** Roster row the space default can copy onto a thread. */
export interface SpaceRosterAgent extends PromptAgent {
  name: string
  model: string
  effort: string
  systemPrompt: string
  sourceNodeBaseUrl: string
  node?: string
  directory?: string
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh']

function asThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  return value !== undefined && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined
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
      /** Den base URL used when no preset is chosen. Not a directory. */
      node?: string
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

/** Where the thread's chat settings live. Preset node wins over an explicit node. */
function settingsHost(
  agent: PromptAgent | undefined,
  node: string | undefined,
  baseUrl: string,
): string {
  const host = agent?.sourceNodeBaseUrl || node
  return host && host.length > 0 ? host : baseUrl
}

/**
 * An unpinned draft's row is keyed by the hub, even when a node binding
 * moves the spawn. A pinned preset row is keyed by the preset's node.
 */
function membershipKeyFor(id: string, agent: PromptAgent | undefined, baseUrl: string): string {
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

/**
 * Prompt-path fields for a space. A preset that is not startable is omitted
 * so the thread does not carry a dead id. Model and effort still pre-fill.
 */
export function initialThreadFields(
  defaults: SpaceDefaults | undefined,
  roster: readonly SpaceRosterAgent[],
): { agentId: string; model: string; effort: ThinkingLevel } {
  const agent = startablePreset(defaults, roster)
  return {
    agentId: agent?.id ?? '',
    model: defaults?.model ?? agent?.model ?? '',
    effort: defaults?.effort ?? asThinkingLevel(agent?.effort) ?? 'medium',
  }
}

function writeSpaceSettings(
  key: string,
  defaults: SpaceDefaults | undefined,
  agent: SpaceRosterAgent | undefined,
): void {
  if (agent) {
    const patch = agentThreadSettings({
      id: agent.id,
      harnessId: agent.harnessId,
      model: agent.model,
      effort: agent.effort,
      systemPrompt: agent.systemPrompt,
    })
    if (defaults?.model) patch.model = defaults.model
    if (defaults?.effort) {
      patch.effort = defaults.effort
      patch.harnessEffort = defaults.effort
    }
    useChatSettings.getState().set(key, patch)
    return
  }
  // Missing preset: do not copy agentId. Model and effort are the user's
  // own defaults and still apply. The spawn notice stays the chat page's.
  if (!defaults?.model && !defaults?.effort) return
  const patch: Partial<ChatSettings> = {}
  if (defaults.model) patch.model = defaults.model
  if (defaults.effort) {
    patch.effort = defaults.effort
    patch.harnessEffort = defaults.effort
  }
  useChatSettings.getState().set(key, patch)
}

/**
 * Mint a draft in `spaceId` the way `startNewConversation` mints a bare
 * draft, then stamp the space defaults. Does not enqueue a turn and does
 * not call the rail. No defaults still places the draft and writes nothing.
 */
export function startThreadInSpace(
  spaceId: string,
  baseUrl: string,
  roster: readonly SpaceRosterAgent[],
): string | undefined {
  if (!spaceExists(spaceId)) return undefined
  const defaults = useSpaces.getState().spaces.find((space) => space.id === spaceId)?.defaults
  const agent = startablePreset(defaults, roster)
  const id = agent ? mintWithAgent(agent, baseUrl) : mintPlainDraft()
  if (!id) return undefined
  const explicitNode = agent ? undefined : defaults?.node
  if (explicitNode) setSessionNodeBinding(id, explicitNode, baseUrl)
  writeSpaceSettings(`${settingsHost(agent, explicitNode, baseUrl)}::${id}`, defaults, agent)
  useSpaces.getState().place(membershipKeyFor(id, agent, baseUrl), spaceId)
  return id
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
  const explicitNode = action.agent ? undefined : action.node
  if (explicitNode) setSessionNodeBinding(id, explicitNode, action.baseUrl)
  const key = `${settingsHost(action.agent, explicitNode, action.baseUrl)}::${id}`
  writeSettings(key, action.agent, action.model, action.effort)
  useSpaces.getState().place(membershipKeyFor(id, action.agent, action.baseUrl), action.spaceId)
  useChat.getState().enqueueOutbound(id, text)
  return id
}
