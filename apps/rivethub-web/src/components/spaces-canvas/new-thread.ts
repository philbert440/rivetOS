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
 *
 * An explicit node (or a preset's node) is used only when the connection
 * roster still lists it — the same binding rule as `resolveSessionNode`.
 * Anything else starts on the hub. Settings, the binding, and membership
 * are all written on that resolved node, so adoption rekeys the row that
 * was actually placed.
 */

import { rosterCommandFor, type HarnessId, type ThinkingLevel } from '@rivetos/types'
import { agentThreadSettings } from '../../lib/agent-roster.js'
import { setAgentLastSession } from '../../lib/agent-session.js'
import { urlLabel } from '../../lib/node-name.js'
import { setSessionNodeBinding } from '../../lib/session-node.js'
import { uuidv4 } from '../../lib/uuid.js'
import { useChat } from '../../stores/chat.js'
import { useChatSettings, type ChatSettings } from '../../stores/chat-settings.js'
import { useConnection } from '../../stores/connection.js'
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
      /**
       * The space's default preset when it is no longer in the roster and the
       * user did not pick another agent. Carried so the first spawn reaches
       * the den's agent-not-found recovery and DELETED_PRESET_NOTICE.
       */
      missingPreset?: { agentId: string; harnessId?: HarnessId }
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

function connectionRosterUrls(): readonly string[] {
  return useConnection.getState().roster.map((node) => node.baseUrl)
}

/**
 * Binding rule from `resolveSessionNode`: the current node is home; any
 * other URL must be on the connection roster. An off-roster URL is not a
 * destination — the caller falls back to the hub and can say so.
 */
export function resolveRosterNode(
  candidate: string | undefined,
  currentBase: string,
  rosterUrls: readonly string[],
): { node: string; unavailable: string | undefined } {
  const wanted = candidate?.trim() ?? ''
  if (!wanted || wanted === currentBase) return { node: currentBase, unavailable: undefined }
  if (rosterUrls.includes(wanted)) return { node: wanted, unavailable: undefined }
  return { node: currentBase, unavailable: wanted }
}

/** One line in the new-thread dialog. Same words for every off-roster start. */
export function offRosterStartNotice(node: string, hub: string): string {
  return `${urlLabel(node)} is not in your roster — starting on ${urlLabel(hub)}`
}

/** Set by `startThreadInSpace` when Ctrl+T fell back to the hub. */
let offRosterNotice: string | undefined

/** The dialog sentence, if the last `startThreadInSpace` fell back. One read. */
export function takeOffRosterNotice(): string | undefined {
  const notice = offRosterNotice
  offRosterNotice = undefined
  return notice
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

function writeSettings(
  key: string,
  agent: PromptAgent | undefined,
  model: string | undefined,
  effort: ThinkingLevel | undefined,
  missingPreset?: { agentId: string; harnessId?: HarnessId },
): void {
  // An explicit Plain draft does not copy a missing preset id; the space's
  // own deleted default (missingPreset, set by the dialog only when the user
  // left the agent untouched) does, so the first spawn shows the notice.
  const base: Partial<ChatSettings> = agent
    ? agentThreadSettings({
        id: agent.id,
        harnessId: agent.harnessId,
        model: agent.model ?? '',
        effort: agent.effort ?? '',
        systemPrompt: agent.systemPrompt ?? '',
      })
    : { agent: '', effort: effort ?? 'medium' }
  if (!agent && missingPreset) {
    base.agentId = missingPreset.agentId
    if (missingPreset.harnessId) {
      base.harnessId = missingPreset.harnessId
      base.agent = rosterCommandFor(missingPreset.harnessId) ?? ''
    }
  }
  if (model !== undefined) base.model = model
  if (effort !== undefined) {
    base.effort = effort
    base.harnessEffort = effort
  }
  useChatSettings.getState().set(key, base)
}

/**
 * Prompt-path fields for a space. A preset that is not startable is omitted
 * from the picker so the thread does not look selected. Model and effort
 * still pre-fill. Plain draft does not copy the missing id. Ctrl+T does.
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
  // Missing preset: copy the id (and harness, when we stored one) so the
  // first spawn hits the den's agent-not-found recovery. Do not pin it.
  // Model and effort are the user's own defaults and still apply.
  if (!defaults?.agentId && !defaults?.model && !defaults?.effort) return
  const patch: Partial<ChatSettings> = {}
  if (defaults?.agentId) {
    patch.agentId = defaults.agentId
    if (defaults.harnessId) {
      patch.harnessId = defaults.harnessId
      patch.agent = rosterCommandFor(defaults.harnessId) ?? ''
    }
  }
  if (defaults?.model) patch.model = defaults.model
  if (defaults?.effort) {
    patch.effort = defaults.effort
    patch.harnessEffort = defaults.effort
  }
  useChatSettings.getState().set(key, patch)
}

/**
 * Mint a draft in `spaceId` the way `startNewConversation` mints a bare
 * draft, then stamp the space defaults. Does not enqueue a turn and does
 * not call the rail. No defaults still places the draft and writes nothing.
 * An off-roster node is not written: the draft stays on the hub, and
 * `takeOffRosterNotice` returns the dialog's sentence for that fallback.
 */
export function startThreadInSpace(
  spaceId: string,
  baseUrl: string,
  roster: readonly SpaceRosterAgent[],
): string | undefined {
  const defaults = useSpaces.getState().spaces.find((space) => space.id === spaceId)?.defaults
  return startThreadWithDefaults(spaceId, defaults, baseUrl, roster)
}

/**
 * `startThreadInSpace` with the defaults given rather than read from the
 * space — Settings → General's new-conversation defaults use this.
 */
export function startThreadWithDefaults(
  spaceId: string,
  defaults: SpaceDefaults | undefined,
  baseUrl: string,
  roster: readonly SpaceRosterAgent[],
): string | undefined {
  if (!spaceExists(spaceId)) {
    offRosterNotice = undefined
    return undefined
  }
  const found = startablePreset(defaults, roster)
  const resolved = resolveRosterNode(
    found?.sourceNodeBaseUrl || defaults?.node,
    baseUrl,
    connectionRosterUrls(),
  )
  // A preset whose node left the roster is not pinned. A pointer would
  // fail closed and ignore this hub fallback.
  const agent = found && !resolved.unavailable ? found : undefined
  const id = agent ? mintWithAgent(agent, baseUrl) : mintPlainDraft()
  if (!id) {
    offRosterNotice = undefined
    return undefined
  }
  if (!agent && resolved.node !== baseUrl) setSessionNodeBinding(id, resolved.node, baseUrl)
  const key = `${resolved.node}::${id}`
  const settingsDefaults: SpaceDefaults | undefined =
    found && resolved.unavailable
      ? {
          model: defaults?.model ?? found.model,
          effort: defaults?.effort ?? asThinkingLevel(found.effort),
        }
      : defaults
  writeSpaceSettings(key, settingsDefaults, agent)
  useSpaces.getState().place(key, spaceId)
  offRosterNotice = resolved.unavailable
    ? offRosterStartNotice(resolved.unavailable, baseUrl)
    : undefined
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
  const resolved = resolveRosterNode(
    action.agent?.sourceNodeBaseUrl || action.node,
    action.baseUrl,
    connectionRosterUrls(),
  )
  const agent = action.agent && !resolved.unavailable ? action.agent : undefined
  const id = agent ? mintWithAgent(agent, action.baseUrl) : mintPlainDraft()
  if (!id) return undefined
  if (!agent && resolved.node !== action.baseUrl) {
    setSessionNodeBinding(id, resolved.node, action.baseUrl)
  }
  const key = `${resolved.node}::${id}`
  writeSettings(key, agent, action.model, action.effort, agent ? undefined : action.missingPreset)
  useSpaces.getState().place(key, action.spaceId)
  useChat.getState().enqueueOutbound(id, text)
  return id
}

/**
 * Whether the chooser's Prompt path may start. Shared by the Start button and
 * Enter in the prompt box, so a keyboard start can never skip the seeding
 * guard (an unseeded start would ignore the space's preset and node).
 */
export function canStartThread(input: {
  prompt: string
  target: string | undefined
  seedReady: boolean
}): boolean {
  return input.prompt.trim().length > 0 && Boolean(input.target) && input.seedReady
}
